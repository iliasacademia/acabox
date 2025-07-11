const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const https = require("https");
const axios = require('axios');
const  { HttpCookieAgent, HttpsCookieAgent } = require('http-cookie-agent/http');
const axiosCookieJarSupport = require('axios-cookiejar-support').wrapper;
const tough = require('tough-cookie');
const { login, uploadFile } = require('./uploader.js');

let mainWindow;

const devIP = '10.40.2.129';
// app.commandLine.appendSwitch('host-rules', `MAP *.devemia.com ${devIP},MAP devemia.com ${devIP}`);
// TODO: DO NOT DO THIS IN PRODUCTION
app.commandLine.appendSwitch('ignore-certificate-errors');


const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
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

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0];
});

ipcMain.handle('upload-files', async (event, folderPath) => {
  // TODO: Parallelize
  await login();
  const files = fs.readdirSync(folderPath);
  const formData = new FormData();


  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf')) continue;
    const filePath = path.join(folderPath, file);
    console.log(`Uploading ${filePath}`);
    // Do this synchronously so as not to overwhelm the server and the user’s network
    await uploadFile(filePath);
  }
});