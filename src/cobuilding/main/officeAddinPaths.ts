import * as path from 'path';
import * as os from 'os';

export const ADDIN_ID = 'e56ffae3-be6a-463a-a4a2-9ec965f8d2d7';
export const MANIFEST_NAME = `${ADDIN_ID}.manifest.xml`;

export const WEF_DIRS = {
  word: path.join(os.homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents/wef'),
  powerpoint: path.join(os.homedir(), 'Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef'),
  excel: path.join(os.homedir(), 'Library/Containers/com.microsoft.Excel/Data/Documents/wef'),
};

export const LOGIN_KEYCHAIN = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');

export function getCertsDir(userDataDir: string): string {
  return path.join(userDataDir, 'ms-office-addin', 'certs');
}

export function getCertPath(userDataDir: string): string {
  return path.join(getCertsDir(userDataDir), 'localhost.crt');
}

export function getKeyPath(userDataDir: string): string {
  return path.join(getCertsDir(userDataDir), 'localhost.key');
}

export function getAddinDir(appRoot: string): string {
  return path.join(appRoot, 'ms_office_addin');
}
