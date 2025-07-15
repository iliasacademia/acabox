const FormData = require('form-data');
const https = require("https");
const axios = require('axios');
const  { HttpCookieAgent, HttpsCookieAgent } = require('http-cookie-agent/http');
const axiosCookieJarSupport = require('axios-cookiejar-support').wrapper;
const {CookieJar} = require('tough-cookie');
const FileCookieStore = require('tough-cookie-file-store').default;

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { readFile } = require('fs/promises');

// TODO: This file should be refactored into a class, so that things like the cookie path can be passed to the constructor. But for now this kludge works.
const { app } = require('electron');

const BASE_URL = process.env.ACADEMIA_API_URL || 'https://api.academia.edu/';

let apiClient;

const APIclient = async () => {
  if (apiClient) {
        return apiClient;
    }
    axiosCookieJarSupport(axios);
    const cookieJar = new CookieJar(new FileCookieStore(path.join(app.getPath('userData'), 'backendCookies.json')));
    const agentArgs = {
      cookies: {jar: cookieJar},
      rejectUnauthorized: !BASE_URL.includes('devdemia'),
      // keepAlive: true
    }
    apiClient = axios.create({
      baseURL: BASE_URL,
    //   withCredentials: true,
      withCredentials: false,
      // jar: cookieJar,
      httpsAgent: new HttpsCookieAgent(agentArgs),
      httpAgent: new HttpCookieAgent(agentArgs),
      headers: {
        Accept: 'application/json',
      }
    });
    return apiClient;
  }

const getCsrfToken = async () => {
    const client = await APIclient();
    const headers = {
        Accept: '*/*',
        'User-Agent': 'curl/8.4.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': 0,
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
    }
    const transitional = {
        silentJSONParsing: false,
        forcedJSONParsing: false,
        // clarifyTimeoutError: false
    }
    const csrfResponse = await client.post('csrf_meta', {}, {headers, transitional,  maxRedirects: 0, transformResponse: x => x });
    // console.log(csrfResponse);
    return csrfResponse.data;
  }

const checkLogin = async () => {
  const client = await APIclient();
  const response = await client.get(`v0/user`, {
    validateStatus: (status) => {
      if ((status >= 200 && status < 300) || status === 401) {
        return true;
      }
      return false;
    }
  });
  return response.status !== 401;
}

const login = async (email, password) => {
    const client = await APIclient();
    const formData = new FormData();
    formData.append('login_email', email);
    formData.append('password', password);
    formData.append('remember_me', 'true');
    const response = await client.post('v0/login', formData, {
      headers: {'x-csrf-token': await getCsrfToken(), ...formData.getHeaders() }
    }).catch(error => {
        const fs = require('node:fs');
        fs.writeFileSync('/tmp/wtf.html', error.response.data);
        console.log(error);
    });
    return response;
  }

const getTitle = async (filePath) => {
  const arrayBuffer = await readFile(filePath);
  const pdf = await PDFDocument.load(arrayBuffer);
  return pdf.getTitle();
}

// Some PDFs have newlines and multiple spaces in the title, as well as control characters.
const normalizeTitle = async (filePath, basePath) => {
  let title = await getTitle(filePath) || filePath.replace(basePath, '');
  // normalize newlines, paragraph-, & line-endings into spaces
  title = title.replace(/\n/g, ' ');
  title = title.replace(/\p{Zl}/gu, ' ');
  title = title.replace(/\p{Zp}/gu, ' ');

  // strip control characters, but not surrogates or formats
  title = title.replace(/\p{Cc}/gu, '');
  title = title.replace(/\p{Co}/gu, '');
  title = title.replace(/\p{Cn}/gu, '');

  // normalize whitespace
  title = title.replace(/\p{Zs}+/gu, ' ');

  return title.trim();
}

const uploadFile = async (filePath, basePath) => {
    const client = await APIclient();
    const formData = new FormData();
    const title = await normalizeTitle(filePath, basePath);
    const csrfToken = await getCsrfToken();
    formData.append('title', title);
    formData.append('file', fs.createReadStream(filePath));
    const response = await client.post('v0/private_papers', formData, {
      headers: {'x-csrf-token': csrfToken, ...formData.getHeaders() },
      validateStatus: (status) => {
        // Allow everything so we can give the user feedback on the error
        return true;
        // return status >= 200 && status < 500;
      }
    });
    // console.log(response);
    return response;
  }

const searchFiles = async (searchTerm) => {
  const client = await APIclient();
  const response = await client.get(`v0/private_papers/`, {
    params: { search: searchTerm },
    // headers: {'x-csrf-token': await getCsrfToken()}
  });
  return response.data;
}

module.exports = {
    // APIclient,
    // getCsrfToken,
    checkLogin,
    login,
    uploadFile,
    searchFiles
}