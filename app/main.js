// require('v8-compile-cache')
const fs = require('fs'),
	path = require('path'),
	url = require('url'),
	{ BrowserWindow, clipboard, app, ipcMain, shell } = require("electron"),
	Store = require('electron-store'),
	log = require('electron-log'),
	shortcuts = require('electron-localshortcut'),
	{ argv } = require('yargs')

Object.assign(console, log.functions)
const config = new Store()

const DEBUG = Boolean(argv.debug || config.get('debug')),
	AUTO_UPDATE = argv.update || config.get('autoUpdate', 'download')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// app.commandLine.appendSwitch('disable-gpu-vsync')
// app.commandLine.appendSwitch('ignore-gpu-blacklist')
// app.commandLine.appendSwitch('enable-zero-copy')
// app.commandLine.appendSwitch('enable-webgl2-compute-context')
if (config.get('disableFrameRateLimit', true)) app.commandLine.appendSwitch('disable-frame-rate-limit')
let angleBackend = config.get('angleBackend', 'default'),
	colorProfile = config.get('colorProfile', 'default')
if (angleBackend != 'default') app.commandLine.appendSwitch('use-angle', angleBackend)
if (colorProfile != 'default') app.commandLine.appendSwitch('force-color-profile', colorProfile)

ipcMain.on('prompt', (event, message, defaultValue) => {
	let promptWin = initPromptWindow(message, defaultValue),
		returnValue = null

	ipcMain.on('prompt-return', (event, value) => returnValue = value)

	promptWin.on('closed', () => {
		event.returnValue = returnValue
	})
})

validateDocuments({
	scripts: null,
	swap: null
})

const swapDir = path.join(app.getPath('documents'), 'idkr/swap'),
	swapFiles = []

function recursiveSwap(win, prefix = '', domain = '') {
	fs.readdirSync(path.join(swapDir, prefix), { withFileTypes: true }).forEach(dirent => {
		if (domain) {
			if (dirent.isDirectory()) recursiveSwap(win, `${prefix}/${dirent.name}`, domain)
			else swapFiles.push({ domain: domain, path: `${prefix}/${dirent.name}`.replace(domain, '') })
		} else recursiveSwap(win, prefix + dirent.name, dirent.name)
	})
	let urls = []
	swapFiles.forEach(file => {
		urls.push(`*://${file.domain + file.path}`)
		urls.push(`*://${file.domain + file.path}?*`)
	})
	win.webContents.session.webRequest.onBeforeRequest({ urls: urls }, (details, callback) => {
		callback({
			redirectURL: url.format({
				protocol: 'file',
				pathname: path.join(swapDir, new URL(details.url).hostname, new url.URL(details.url).pathname)
			})
		})
	})
}

function validateDocuments(structure, prefix = '') {
	let documentDir = path.join(app.getPath('documents'), 'idkr')
	for (let [key, value] of Object.entries(structure)) {
		let dir = path.join(documentDir, prefix, key)
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		if (value != null) validateDocuments(value, prefix + key)
	}
}

function setupWindow(win, isWeb) {
	let contents = win.webContents

	if (DEBUG) contents.openDevTools()
	win.removeMenu()
	win.once('ready-to-show', () => {
		if (locationType(contents.getURL()) == 'game') win.setFullScreen(config.get('fullScreen', false))
		win.show()
	})

	let isMac = process.platform == 'darwin'
	shortcuts.register(win, isMac ? 'Command+Option+I' : 'Control+Shift+I', () => contents.toggleDevTools())
	shortcuts.register(win, isMac ? 'Command+Left' : 'Alt+Left', () => contents.canGoBack() && contents.goBack())
	shortcuts.register(win, isMac ? 'Command+Right' : 'Alt+Right', () => contents.canGoForward() && contents.goForward())
	shortcuts.register(win, 'CommandOrControl+Shift+Delete', () => {
		contents.session.clearCache().then(err => {
			if (err) {
				console.error(err)
				alert('Failed to clear cache')
			} else {
				app.relaunch()
				app.quit()
			}
		})
	})
	shortcuts.register(win, 'CommandOrControl+Alt+F', () => initSettingsWindow())
	shortcuts.register(win, 'Escape', () => contents.executeJavaScript('document.exitPointerLock()'))

	if (!isWeb) return win

	// Codes only runs on web windows

	contents.on('dom-ready', () => {
		let windowType = locationType(contents.getURL())
		if (windowType == 'game') shortcuts.register(win, 'F6', () => win.loadURL('https://krunker.io/'))
	})

	contents.on("new-window", (event, url, frameName, disposition, options) => navigateNewWindow(event, url, options.webContents))
	contents.on("will-navigate", (event, url) => {
		if (locationType(url) == 'external') {
			event.preventDefault()
			shell.openExternal(url)
		} else if (locationType(url) != 'game' && locationType(contents.getURL()) == 'game') navigateNewWindow(event, url)
	})

	// event.preventDefault() didn't work after confirm() or dialog.showMessageBox(), so ignoring beforeunload as a workaround for now
	contents.on('will-prevent-unload', event => event.preventDefault())

	shortcuts.register(win, 'F5', () => contents.reload())
	shortcuts.register(win, 'Shift+F5', () => contents.reloadIgnoringCache())
	shortcuts.register(win, 'F11', () => {
		let full = win.isFullScreen()
		win.setFullScreen(!full)
		if (locationType(contents.getURL()) == 'game') config.set('fullScreen', !full)
	})
	shortcuts.register(win, 'CommandOrControl+L', () => clipboard.writeText(contents.getURL()))
	shortcuts.register(win, 'CommandOrControl+N', () => initWindow('https://krunker.io/'))
	shortcuts.register(win, 'CommandOrControl+Shift+N', () => initWindow(contents.getURL()))
	shortcuts.register(win, 'CommandOrControl+Shift+Alt+R', () => {
		app.relaunch()
		app.quit()
	})

	if (config.get('enableResourceSwapper', false)) recursiveSwap(win)

	function navigateNewWindow(event, url, webContents) {
		event.preventDefault()
		if (locationType(url) == 'external') shell.openExternal(url)
		else if (locationType(url) != 'unknown') event.newGuest = initWindow(url, webContents)
	}

	return win
}

function initWindow(url, webContents) {
	let win = new BrowserWindow({
		width: 1600,
		height: 900,
		show: false,
		webContents: webContents,
		webPreferences: {
			preload: path.join(__dirname, 'preload/global.js'),
			webSecurity: false
		}
	})
	let contents = win.webContents
	setupWindow(win, true)

	if (!webContents) win.loadURL(url)

	return win
}

function initSplashWindow() {
	let win = new BrowserWindow({
		width: 600,
		height: 300,
		center: true,
		resizable: false,
		show: false,
		frame: false,
		transparent: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload/splash.js')
		}
	})
	let contents = win.webContents

	autoUpdate().finally(() => launchGame())

	async function autoUpdate() {
		return new Promise((resolve, reject) => {
			if (AUTO_UPDATE == 'skip') resolve()
			else {
				contents.on("dom-ready", () => {
					contents.send('message', 'Initializing the auto updater...')
					const { autoUpdater } = require('electron-updater')
					autoUpdater.logger = log

					autoUpdater.on('error', err => {
						console.error(err)
						contents.send('message', 'Error: ' + err.name)
						reject(`Error occured: ${err.name}`)
					})
					autoUpdater.on('checking-for-update', () => contents.send('message', 'Checking for update'))
					autoUpdater.on('update-available', info => {
						console.log(info)
						contents.send('message', `Update v${info.version} available`, `${info.releaseDate} / ${info.files.join(', ')}`)
						if (AUTO_UPDATE != 'download') resolve()
					})
					autoUpdater.on('update-not-available', info => {
						console.log(info)
						contents.send('message', 'No update available')
						resolve()
					})
					autoUpdater.on('download-progress', info => {
						contents.send('message', `Downloaded ${Math.floor(info.percent)}%`, Math.floor(info.bytesPerSecond / 1000) + 'kB/s')
						win.setProgressBar(info.percent / 100)
					})
					autoUpdater.on('update-downloaded', info => {
						contents.send('message', null, 'Installing...')
						autoUpdater.quitAndInstall(true, true)
					})

					autoUpdater.autoDownload = AUTO_UPDATE == 'download'
					autoUpdater.checkForUpdates()
				})
			};
		})
	}

	setupWindow(win)
	win.loadFile("app/html/splash.html")
	return win

	function launchGame() {
		initWindow('https://krunker.io/')
		setTimeout(() => win.destroy(), 2000)
	}
}

function initPromptWindow(message, defaultValue) {
	let win = new BrowserWindow({
		width: 480,
		height: 240,
		center: true,
		show: false,
		frame: false,
		resizable: false,
		transparent: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload/prompt.js')
		}
	})
	let contents = win.webContents

	setupWindow(win)
	win.once('ready-to-show', () => {
		contents.send('prompt-data', message, defaultValue)
	})

	win.loadFile('app/html/prompt.html')

	return win
}

function initSettingsWindow() {
	let win = new BrowserWindow({
		width: 600,
		height: 600,
		center: true,
		show: false,
		frame: false,
		transparent: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload/settings.js')
		}
	})
	let contents = win.webContents

	setupWindow(win)

	win.loadFile('app/html/settings.html')

	return win
}

function locationType(url = '') {
	if (!isValidURL(url)) return 'unknown'
	const target = new URL(url)
	if (/^(www\.)?krunker\.io$/.test(target.hostname)) {
		if (/^\/docs\/.+\.txt$/.test(target.pathname)) return 'docs'
		switch (target.pathname) {
			case '/': return 'game'
			case '/social.html': return 'social'
			case '/viewer.html': return 'viewer'
			case '/editor.html': return 'editor'
			default: return 'unknown'
		}
	} else return 'external'

	function isValidURL(url = '') {
		try {
			new URL(url)
			return true
		} catch (e) {
			return false
		}
	}
}

app.once("ready", () => { initSplashWindow() })
app.on('window-all-closed', () => {
	app.quit()
})