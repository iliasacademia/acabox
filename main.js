const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const https = require("https");
const axios = require('axios');
const  { HttpCookieAgent, HttpsCookieAgent } = require('http-cookie-agent/http');
const axiosCookieJarSupport = require('axios-cookiejar-support').wrapper;
const tough = require('tough-cookie');
const { login, uploadFile, searchFiles, checkLogin } = require('./uploader.js');

let mainWindow;

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('check-login', async () => {
  const result = await checkLogin();
  return result;
});

ipcMain.handle('login', async (_event, email, password) => {
  const result = await login(email, password);
  return {success: result.status >= 200 && result.status < 300, data: result.data};
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0];
});

ipcMain.handle('upload-files', async (event, folderPath) => {
  const files = fs.readdirSync(folderPath, {recursive: true});
  const formData = new FormData();


  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf')) continue;
    const filePath = path.join(folderPath, file);
    console.log(`Uploading ${filePath}`);
    // Do this synchronously so as not to overwhelm the server and the user’s network
    const result = await uploadFile(filePath, folderPath);
    mainWindow.webContents.send('file-uploaded', {status: result.status, paper: result.data.private_paper});
  }
});

ipcMain.handle('search-files', async (event, searchTerm) => {
  const results = await searchFiles(searchTerm);
  return results;
});
