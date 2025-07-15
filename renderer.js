$(document).ready(() => {
  $('#selectFolder').on('click', async () => {
    const folderPath = await window.electronAPI.invoke('select-folder');
    if (folderPath) {
        $('#selectedPath').text(`Selected folder: ${folderPath}`);
        await window.electronAPI.invoke('upload-files', folderPath);
    }
  });

  window.electronAPI.on('file-uploaded', (evt, result) => {
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

  $('#searchButton').on('click', async () => {
    const searchTerm = $('#searchInput').val();
    const results = await window.electronAPI.invoke('search-files', searchTerm);
    results.private_papers.forEach(result => {
      $('#searchResultsBody').append(`<tr><td class="id">${result.id}</td><td class="title">${result.title}</td><td class="file">${result.file_name}</td></tr>`);
    });
    $('#searchResults').show();
  });

  $('#loginButton').on('click', async () => {
    const email = $('#loginEmail').val();
    const password = $('#loginPassword').val();
    const result = await window.electronAPI.invoke('login', email, password);
    if (result.success) {
      $('#loginModal').hide();
    } else {
      $('#loginError').text(result.data.message).show();
    }
  });

  const showConditionalLogin = async () => {
    const isLoggedIn = await window.electronAPI.invoke('check-login');
    if (!isLoggedIn) {
      $('#loginModal').show();
    }
  }

  showConditionalLogin();
});