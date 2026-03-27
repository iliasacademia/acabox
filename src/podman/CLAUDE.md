# Writing Agent Container

You are running inside a sandboxed Podman container with no internet access (except the Anthropic API).

## Preview Server

A preview server is running and accessible to the user's browser. Use it to display your output.

- **Output directory**: `/workspace/output/`
- **Preview URL**: The user can view files at the preview server (the URL is shown in the Electron app tray menu under "Open Preview")
- Write HTML files to `/workspace/output/` and they are immediately viewable
- The main entry point should be `/workspace/output/index.html`

### Available JavaScript libraries (served at /vendor/)

Use these script tags in your HTML — they are pre-installed and served locally:

```html
<script src="/vendor/chart.js/chart.umd.js"></script>       <!-- Chart.js -->
<script src="/vendor/plotly/plotly.min.js"></script>          <!-- Plotly.js -->
<script src="/vendor/d3/d3.min.js"></script>                  <!-- D3.js -->
<script src="/vendor/papaparse/papaparse.min.js"></script>    <!-- PapaParse (CSV parsing) -->
```

### Accessing data files

Files in `/workspace/` are served at `/data/` on the preview server:
- `/workspace/mydata.csv` is accessible as `/data/mydata.csv` in your HTML
- Use PapaParse or fetch() to load CSV data: `fetch('/data/mydata.csv')`

### Example: CSV visualization

```html
<!DOCTYPE html>
<html>
<head>
  <title>Data Analysis</title>
  <script src="/vendor/chart.js/chart.umd.js"></script>
  <script src="/vendor/papaparse/papaparse.min.js"></script>
</head>
<body>
  <canvas id="chart"></canvas>
  <script>
    Papa.parse('/data/mydata.csv', {
      download: true,
      header: true,
      complete: function(results) {
        // Process results.data and create chart
      }
    });
  </script>
</body>
</html>
```

## Available Python libraries

For data analysis, these Python libraries are pre-installed:

- **pandas** — DataFrames, CSV/Excel reading, data manipulation
- **numpy** — Numerical computing
- **matplotlib** / **seaborn** — Static chart generation (save as PNG/SVG to /workspace/output/)
- **scipy** — Scientific computing, statistics
- **scikit-learn** — Machine learning
- **plotly** (Python) — Interactive charts (can export to HTML)
- **statsmodels** — Statistical models and tests
- **openpyxl** / **xlsxwriter** — Excel file support

### Python + HTML workflow

You can use Python to analyze data and generate HTML output:

```python
import pandas as pd
import plotly.express as px

df = pd.read_csv('/workspace/mydata.csv')
fig = px.bar(df, x='category', y='value', title='My Chart')
fig.write_html('/workspace/output/index.html')
```

Or generate static images:

```python
import matplotlib.pyplot as plt
import pandas as pd

df = pd.read_csv('/workspace/mydata.csv')
df.plot(kind='bar')
plt.savefig('/workspace/output/chart.png')
```

## Workspace

- `/workspace/` — Mounted from the host. User's files (CSVs, etc.) are here.
- `/workspace/output/` — Write your generated HTML/images here for the preview server.
- All files in `/workspace/` persist across container restarts.

## Constraints

- No internet access except api.anthropic.com
- All tools and libraries are pre-installed — you cannot install new packages at runtime
- Write output to `/workspace/output/` for the user to view
