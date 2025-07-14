const FormData = require('form-data');
const https = require("https");
const axios = require('axios');
const  { HttpCookieAgent, HttpsCookieAgent } = require('http-cookie-agent/http');
const axiosCookieJarSupport = require('axios-cookiejar-support').wrapper;
const tough = require('tough-cookie');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { readFile } = require('fs/promises');

// devdemia’s SSL certificate is only for the base domain, and Node SSL libraries don’t honor rejectUnauthorized with a name mismatch (!!)
// const BASE_URL = 'https://api.devdemia.com/';
const BASE_URL = 'https://www.devdemia.com/';
// const BASE_URL = 'https://api.scholarific.com/';
//const BASE_URL = 'https://requestmirror.dev/api/v1/test-endpoint';
// disable for production
const QUERY = { subdomain_param: 'api' }
const SUBDOMAIN_SUFFIX = `?${new URLSearchParams(QUERY).toString()}`;
// const QUERY = {};
// const SUBDOMAIN_SUFFIX = ''; // TODO: rewrite the above to handle the empty case

let apiClient;

const APIclient = async () => {

  if (apiClient) {
        return apiClient;
    }
    axiosCookieJarSupport(axios);
    // DANGEROUS: disable TLS verification for devdemia.com (Name mismatch is not covered by rejectUnauthorized)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const cookieJar = new tough.CookieJar();
    const agentArgs = {
      cookies: {jar: cookieJar},
      rejectUnauthorized: false, // just for dev, we need to DtRT for production
    //  keepAlive: true
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
    const csrfResponse = await client.post(`csrf_meta${SUBDOMAIN_SUFFIX}`, {}, {headers, transitional,  maxRedirects: 0, transformResponse: x => x });
    // console.log(csrfResponse);
    return csrfResponse.data;
  }

const login = async () => {
    const client = await APIclient();
    const formData = new FormData();
    formData.append('login_email', process.env.UPLOAD_USERNAME);
    formData.append('password', process.env.UPLOAD_PASSWORD);
    formData.append('remember_me', 'true');
    const response = await client.post(`v0/login${SUBDOMAIN_SUFFIX}`, formData, {
      headers: {'x-csrf-token': await getCsrfToken(), ...formData.getHeaders() }
    }).catch(error => {
        const fs = require('node:fs');
        fs.writeFileSync('/tmp/wtf.html', error.response.data);
        console.log(error);
    });
    return response.data;
  }

const getTitle = async (filePath) => {
  const arrayBuffer = await readFile(filePath);
  const pdf = await PDFDocument.load(arrayBuffer);
  return pdf.getTitle();
}

// Some PDFs have newlines and multiple spaces in the title, as well as control characters.
const normalizeTitle = async (filePath) => {
  let title = await getTitle(filePath) || filePath;
  // strip control characters, but not surrogates or formats
  title = title.replace(/\p{Cc}/gu, '');
  title = title.replace(/\p{Co}/gu, '');
  title = title.replace(/\p{Cn}/gu, '');

  // normalize newlines, paragraph-, & line-endings into spaces
  title = title.replace(/\n\r/g, ' ');
  title = title.replace(/\p{Zl}/gu, ' ');
  title = title.replace(/\p{Zp}/gu, ' ');

  // normalize whitespace
  title = title.replace(/\p{Zs}+/gu, ' ');

  return title.trim();
}

const uploadFile = async (filePath) => {
    const client = await APIclient();
    const formData = new FormData();
    const title = await normalizeTitle(filePath);
    const csrfToken = await getCsrfToken();
    formData.append('title', title);
    formData.append('file', fs.createReadStream(filePath));
    const response = await client.post(`v0/private_papers${SUBDOMAIN_SUFFIX}`, formData, {
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
  if (!apiClient) {
    await login();
  }
  const client = await APIclient();
  const response = await client.get(`v0/private_papers/search`, {
    params: { search: searchTerm, ...QUERY },
    // headers: {'x-csrf-token': await getCsrfToken()}
  });
  return response.data;
}

module.exports = {
    APIclient,
    getCsrfToken,
    login,
    uploadFile,
    searchFiles
}