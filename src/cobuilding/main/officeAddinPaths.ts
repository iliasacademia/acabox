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

export function getCertsDir(projectRoot: string): string {
  return path.join(projectRoot, 'ms_office_addin', '.certs');
}

export function getCertPath(projectRoot: string): string {
  return path.join(getCertsDir(projectRoot), 'localhost.crt');
}

export function getKeyPath(projectRoot: string): string {
  return path.join(getCertsDir(projectRoot), 'localhost.key');
}

export function getAddinDir(projectRoot: string): string {
  return path.join(projectRoot, 'ms_office_addin');
}
