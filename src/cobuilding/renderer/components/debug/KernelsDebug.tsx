import React, { useState, useEffect, useCallback } from 'react';

export const KernelsDebug: React.FC = () => {
  const [kernels, setKernels] = useState<JupyterKernelInfo[]>([]);
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [shuttingDown, setShuttingDown] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const status = await window.jupyterAPI.gatewayStatus();
      setGatewayRunning(status.running);
      if (status.running) {
        const list = await window.jupyterAPI.listKernels();
        setKernels(Array.isArray(list) ? list : []);
      } else {
        setKernels([]);
      }
    } catch {
      setGatewayRunning(false);
      setKernels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleShutdown = async (kernelId: string) => {
    setShuttingDown((prev) => new Set(prev).add(kernelId));
    try {
      await window.jupyterAPI.shutdownKernel(kernelId);
      setKernels((prev) => prev.filter((k) => k.id !== kernelId));
    } finally {
      setShuttingDown((prev) => {
        const next = new Set(prev);
        next.delete(kernelId);
        return next;
      });
    }
  };

  const stateColor = (state: string) => {
    if (state === 'idle') return '#4caf50';
    if (state === 'busy') return '#f59e0b';
    if (state === 'starting') return '#f59e0b';
    return '#999';
  };

  const formatActivity = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString();
    } catch {
      return iso;
    }
  };

  if (loading) {
    return (
      <div className="debugSection">
        <h3 className="debugSection__title">Jupyter Kernels</h3>
        <div className="debugSection__status"><span>Loading...</span></div>
      </div>
    );
  }

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Jupyter Kernels</h3>

      <div className="debugSection__status">
        <span
          className={`debugSection__indicator ${gatewayRunning ? 'debugSection__indicator--running' : 'debugSection__indicator--stopped'}`}
        />
        <span>Gateway {gatewayRunning ? 'online' : 'offline'}</span>
        <button
          className="debugSection__btnInline"
          onClick={refresh}
          style={{ marginLeft: 8 }}
        >
          Refresh
        </button>
      </div>

      {!gatewayRunning ? (
        <div style={{ fontSize: 13, color: '#666' }}>
          Kernel gateway is offline. Open a mini-app to retry.
        </div>
      ) : kernels.length === 0 ? (
        <div style={{ fontSize: 13, color: '#666' }}>
          No active kernels. Open a notebook to start one.
        </div>
      ) : (
        <div className="debugSection__tableWrap">
          <table className="debugSection__table">
            <thead>
              <tr>
                <th>Kernel</th>
                <th>State</th>
                <th>Last Activity</th>
                <th>Connections</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {kernels.map((kernel) => (
                <tr key={kernel.id}>
                  <td>
                    <span>{kernel.name}</span>
                    <br />
                    <span className="debugSection__mono">{kernel.id.slice(0, 8)}</span>
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: stateColor(kernel.execution_state),
                      marginRight: 6,
                      verticalAlign: 'middle',
                    }} />
                    {kernel.execution_state}
                  </td>
                  <td>{formatActivity(kernel.last_activity)}</td>
                  <td>{kernel.connections}</td>
                  <td>
                    <button
                      className="debugSection__btnInline debugSection__btnInline--danger"
                      onClick={() => handleShutdown(kernel.id)}
                      disabled={shuttingDown.has(kernel.id)}
                    >
                      {shuttingDown.has(kernel.id) ? 'Stopping...' : 'Shutdown'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
