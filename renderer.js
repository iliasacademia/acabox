const { ipcRenderer } = nodeRequire('electron');

$(document).ready(() => {
  $('#selectFolder').on('click', async () => {
    const folderPath = await ipcRenderer.invoke('select-folder');
    if (folderPath) {
        $('#selectedPath').text(`Selected folder: ${folderPath}`);
        await ipcRenderer.invoke('upload-files', folderPath);
    }
  });

  $('#searchButton').on('click', async () => {
    const searchTerm = $('#searchInput').val();
    const results = await ipcRenderer.invoke('search-files', searchTerm);
    const sr = $('#searchResults');
    sr.text(`Search results: ${JSON.stringify(results)}`);
    sr.show();
  });

  ipcRenderer.on('file-uploaded', (evt, result) => {
    console.log(result);
    // TODO: extract this to a function
    let status = '❓';
    if (result.status >= 200 && result.status < 300) {
      status = '✅';
    } else if (result.status >= 300 && result.status < 400) {
      status = '⚠️';
    } else if (result.status >= 400 && result.status < 500) {
      status = '❌';
    } else {
      status = '🔥';
    }

    $('#uploadedFilesBody').append(`<tr><td class="title">${result.paper.title}</td><td class="file">${result.paper.file_file_name}</td><td class="result">${status}</td></tr>`);
    $('#uploadedFiles').show();
  });
});