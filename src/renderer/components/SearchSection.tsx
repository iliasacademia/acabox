import React, { useState } from 'react';

interface SearchResult {
  id: number;
  title: string;
  file_name: string;
}

const SearchSection: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const handleSearch = async () => {
    const results = await window.electronAPI.invoke('search-files', searchTerm);
    setSearchResults(results.private_papers || []);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <div>
      <h1>Title Search</h1>
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search by title"
        onKeyPress={handleKeyPress}
      />
      <button onClick={handleSearch}>Search</button>
      {searchResults.length > 0 && (
        <div>
          <h1>Results</h1>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {searchResults.map((result) => (
                <tr key={result.id}>
                  <td>{result.id}</td>
                  <td>{result.title}</td>
                  <td>{result.file_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SearchSection;
