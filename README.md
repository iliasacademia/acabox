# Academia Electron

A desktop application for uploading and managing PDF files on Academia.edu.

## Overview

Academia Electron is an Electron-based desktop application that provides a user-friendly interface for bulk uploading PDF files to Academia.edu and searching through uploaded papers. The application handles authentication, extracts PDF metadata, and manages file uploads with real-time progress tracking.

## Features

- **User Authentication**: Secure login to Academia.edu with session persistence
- **Bulk PDF Upload**: Select a folder and upload all PDF files recursively
- **Smart Title Extraction**: Automatically extracts and normalizes PDF titles from metadata
- **Search Functionality**: Search through your uploaded papers by title
- **Real-time Progress**: Visual feedback during upload operations
- **Cookie-based Sessions**: Persistent authentication using secure cookie storage

## Prerequisites

- Node.js 14+ and npm
- An Academia.edu account

## Installation

1. Clone the repository:
   ```bash
   cd academia-electron
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Development

### Running the Application

Start the application in development mode:

```bash
npm start
```

This will launch the Electron app with hot-reloading enabled.

### Development Tools

To enable Chrome DevTools, uncomment line 26 in `main.js`:

```javascript
mainWindow.webContents.openDevTools();
```

## Building

### Package the Application

Create a distributable package:

```bash
npm run package
```

### Create Installers

Generate platform-specific installers:

```bash
npm run make
```

Supported platforms:
- **macOS**: ZIP archive
- **Windows**: Squirrel installer
- **Linux**: DEB and RPM packages

## Project Structure

```
academia-electron/
├── main.js           # Main Electron process
├── preload.js        # Preload script for IPC communication
├── renderer.js       # Frontend logic
├── uploader.js       # Academia.edu API client
├── index.html        # Application UI
├── forge.config.js   # Electron Forge configuration
└── package.json      # Project dependencies
```

### Key Components

- **main.js**: Electron main process that creates windows and handles IPC communication
- **uploader.js**: Core API client for Academia.edu operations (login, upload, search)
- **preload.js**: Secure bridge between renderer and main processes
- **renderer.js**: UI event handlers and DOM manipulation
- **index.html**: Application interface with login modal, upload status, and search

## Usage

1. **Login**: On first launch, you'll be prompted to log in with your Academia.edu credentials
2. **Select Folder**: Click "Choose Folder" to select a directory containing PDF files
3. **Upload**: The app will automatically upload all PDF files found in the selected folder
4. **Search**: Use the search bar to find papers by title

## Configuration

### Custom API URL

Set a custom Academia.edu API endpoint:

```bash
export ACADEMIA_API_URL=https://your-custom-api.academia.edu/
```

The default is `https://api.academia.edu/`.

## Security Features

This application implements modern Electron security best practices:

- **Context Isolation**: Enabled to prevent renderer process from accessing Node.js/Electron APIs directly
- **No Node Integration**: Disabled in renderer process
- **Preload Script**: Secure IPC communication through exposed APIs only
- **Cookie Encryption**: Enabled via Electron Fuses
- **ASAR Integrity Validation**: Prevents tampering with packaged code

## Data Storage

- **Cookies**: Stored in the user's application data directory (`userData/backendCookies.json`)
- **Session Persistence**: Login sessions persist across app restarts

## Dependencies

### Core
- **electron**: Cross-platform desktop framework
- **axios**: HTTP client for API requests
- **tough-cookie**: Cookie parsing and storage
- **pdf-lib**: PDF metadata extraction

### Development
- **@electron-forge**: Build and packaging tools
- **@electron/fuses**: Security configuration

## Known Issues & TODOs

- jQuery is loaded from CDN (see index.html:121) - should be packaged locally
- Styles are inline (see index.html:8) - should be moved to SCSS
- uploader.js should be refactored into a class (see uploader.js:14)

## License

UNLICENSED

## Author

Academia.edu
