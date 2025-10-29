import React, { useState, useEffect, useRef } from 'react';

interface Position {
  x: number;
  y: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PageCornerVisibility {
  isVisible: boolean;
  inViewport: boolean;
  visibleRangeStart: number;
  visibleRangeLength: number;
}

interface ParentElement {
  level: number;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ButtonState {
  x: number;
  y: number;
  width: number;
  height: number;
  isVisible: boolean;
}

interface ButtonStates {
  academiaButton: ButtonState | null;
  countButton: ButtonState | null;
}

interface PositionDebugData {
  documentTopLeftCorner: Position | null;
  wordWindowBounds: Bounds | null;
  firstLinePosition: Bounds | null;
  pageCornerVisibility: PageCornerVisibility | null;
  parentHierarchy: ParentElement[];
  buttonStates: ButtonStates | null;
  scrollAreaBounds: Bounds | null;
  screenHeight: number;
  timestamp: number;
}

const PositionDebugger: React.FC = () => {
  const [data, setData] = useState<PositionDebugData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState<string | null>(null);
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchPositionData = async () => {
    try {
      const result = await window.electronAPI.invoke('get-position-debug-info');

      if (result.success) {
        setData(result.data);
        setLastUpdateTime(new Date().toLocaleTimeString());
        setError(null);
      } else {
        setError(result.error || 'Failed to get position data');
      }
    } catch (err: any) {
      setError(err.message || 'Unknown error occurred');
    }
  };

  useEffect(() => {
    // Fetch immediately on mount
    fetchPositionData();

    if (isAutoRefresh) {
      intervalRef.current = setInterval(fetchPositionData, 1000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isAutoRefresh]);

  const toggleAutoRefresh = () => {
    setIsAutoRefresh(!isAutoRefresh);
  };

  const formatCoordinates = (coords: Position | Bounds | null): string => {
    if (!coords) return 'N/A';

    if ('width' in coords) {
      return `x: ${coords.x.toFixed(1)}, y: ${coords.y.toFixed(1)}, w: ${coords.width.toFixed(1)}, h: ${coords.height.toFixed(1)}`;
    }

    return `x: ${coords.x.toFixed(1)}, y: ${coords.y.toFixed(1)}`;
  };

  // Convert Cocoa coordinates (bottom-left origin) to Accessibility API coordinates (top-left origin)
  const convertCocoaToAccessibility = (button: ButtonState, screenHeight: number): Bounds => {
    // Formula: accessibility_y = screen_height - cocoa_y - height
    const accessibilityY = screenHeight - button.y - button.height;
    return {
      x: button.x,
      y: accessibilityY,
      width: button.width,
      height: button.height
    };
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px' }}>
      <h2>Position Debugger</h2>

      <div style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <button onClick={fetchPositionData} style={{ padding: '8px 16px' }}>
          Refresh Now
        </button>
        <button
          onClick={toggleAutoRefresh}
          style={{
            padding: '8px 16px',
            background: isAutoRefresh ? '#4CAF50' : '#666'
          }}
        >
          Auto-Refresh: {isAutoRefresh ? 'ON' : 'OFF'}
        </button>
        {lastUpdateTime && (
          <span style={{ color: '#888', fontSize: '14px' }}>
            Last updated: {lastUpdateTime}
          </span>
        )}
      </div>

      {error && (
        <div style={{
          padding: '15px',
          background: '#ffebee',
          border: '1px solid #f44336',
          borderRadius: '4px',
          marginBottom: '20px',
          color: '#c62828'
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          {/* Word Window Bounds */}
          <div style={{
            padding: '15px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#f9f9f9'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>
              1. Word Document Window
            </h3>
            <div style={{ fontFamily: 'monospace', fontSize: '14px' }}>
              {formatCoordinates(data.wordWindowBounds)}
            </div>
            {!data.wordWindowBounds && (
              <div style={{ color: '#f44336', marginTop: '5px' }}>
                Window bounds not available (Word may not be running)
              </div>
            )}
          </div>

          {/* Document Top Left Corner */}
          <div style={{
            padding: '15px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#f0f8ff'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>
              2. Document Top-Left Corner (Page Corner)
            </h3>
            <div style={{ fontFamily: 'monospace', fontSize: '14px' }}>
              {formatCoordinates(data.documentTopLeftCorner)}
            </div>
            {!data.documentTopLeftCorner && (
              <div style={{ color: '#ff9800', marginTop: '5px' }}>
                Position not available (document may not have focus)
              </div>
            )}
          </div>

          {/* First Line Position */}
          <div style={{
            padding: '15px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff9f0'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>
              3. First Line Position (Character 0)
            </h3>
            <div style={{ fontFamily: 'monospace', fontSize: '14px' }}>
              {formatCoordinates(data.firstLinePosition)}
            </div>
            {!data.firstLinePosition && (
              <div style={{ color: '#ff9800', marginTop: '5px' }}>
                First line position not available
              </div>
            )}
            {data.documentTopLeftCorner && data.firstLinePosition && (
              <div style={{ marginTop: '10px', color: '#666', fontSize: '13px' }}>
                <strong>Top margin:</strong> {(data.firstLinePosition.y - data.documentTopLeftCorner.y).toFixed(1)}px
              </div>
            )}
          </div>

          {/* Page Corner Visibility */}
          <div style={{
            padding: '15px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#f0fff0'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>
              4. Page Corner Visibility
            </h3>
            {data.pageCornerVisibility ? (
              <div style={{ fontSize: '14px' }}>
                <div style={{ marginBottom: '5px' }}>
                  <strong>Is Visible:</strong>{' '}
                  <span style={{
                    color: data.pageCornerVisibility.isVisible ? '#4CAF50' : '#f44336',
                    fontWeight: 'bold'
                  }}>
                    {data.pageCornerVisibility.isVisible ? 'YES' : 'NO'}
                  </span>
                </div>
                <div style={{ marginBottom: '5px' }}>
                  <strong>In Viewport:</strong>{' '}
                  <span style={{
                    color: data.pageCornerVisibility.inViewport ? '#4CAF50' : '#f44336'
                  }}>
                    {data.pageCornerVisibility.inViewport ? 'YES' : 'NO'}
                  </span>
                </div>
                <div style={{ fontFamily: 'monospace', color: '#666', fontSize: '13px', marginTop: '10px' }}>
                  Visible Range: [{data.pageCornerVisibility.visibleRangeStart}, {data.pageCornerVisibility.visibleRangeStart + data.pageCornerVisibility.visibleRangeLength - 1}]
                  {' '}({data.pageCornerVisibility.visibleRangeLength} chars)
                </div>
              </div>
            ) : (
              <div style={{ color: '#ff9800' }}>
                Visibility data not available
              </div>
            )}
          </div>

          {/* Scroll Area Bounds */}
          <div style={{
            padding: '15px',
            border: '2px solid #9C27B0',
            borderRadius: '4px',
            background: '#f3e5f5'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#6A1B9A' }}>
              5. Scroll Area Bounds (Level 4 Parent)
            </h3>
            {data.scrollAreaBounds && data.scrollAreaBounds.x !== 0 && data.scrollAreaBounds.y !== 0 ? (
              <div style={{ fontSize: '14px' }}>
                <div style={{ fontFamily: 'monospace', fontSize: '14px', marginBottom: '10px' }}>
                  {formatCoordinates(data.scrollAreaBounds)}
                </div>
                <div style={{
                  padding: '10px',
                  background: '#4CAF50',
                  color: 'white',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  textAlign: 'center'
                }}>
                  ✓ Scroll Area Found - Button visibility enabled
                </div>
                <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', fontStyle: 'italic' }}>
                  💡 The count button will only show if fully contained within these bounds
                </div>
              </div>
            ) : (
              <div>
                <div style={{
                  padding: '10px',
                  background: '#f44336',
                  color: 'white',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  textAlign: 'center',
                  marginBottom: '10px'
                }}>
                  ✗ Scroll Area Not Found - Button hidden
                </div>
                <div style={{ fontSize: '13px', color: '#c62828' }}>
                  The AXScrollArea was not found at level 4 parent from the focused AXTextArea.
                  This typically means the document structure is different than expected.
                </div>
              </div>
            )}
          </div>

          {/* Parent Hierarchy */}
          <div style={{
            padding: '15px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff5f5'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>
              6. Parent Element Hierarchy (0 = Focused Element)
            </h3>
            {data.parentHierarchy && data.parentHierarchy.length > 0 ? (
              <div style={{ fontSize: '13px', maxHeight: '400px', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
                  <thead>
                    <tr style={{ background: '#f0f0f0', position: 'sticky', top: 0 }}>
                      <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Level</th>
                      <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Role</th>
                      <th style={{ padding: '8px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Y Position</th>
                      <th style={{ padding: '8px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>X Position</th>
                      <th style={{ padding: '8px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.parentHierarchy.map((parent) => (
                      <tr key={parent.level} style={{
                        background: parent.level % 2 === 0 ? '#fff' : '#fafafa',
                        borderBottom: '1px solid #eee'
                      }}>
                        <td style={{ padding: '6px', fontWeight: 'bold', color: '#2196F3' }}>
                          {parent.level}
                        </td>
                        <td style={{ padding: '6px', color: '#333' }}>
                          {parent.role}
                        </td>
                        <td style={{ padding: '6px', textAlign: 'right', fontWeight: 'bold', color: '#f44336' }}>
                          {parent.y.toFixed(1)}
                        </td>
                        <td style={{ padding: '6px', textAlign: 'right', color: '#666' }}>
                          {parent.x.toFixed(1)}
                        </td>
                        <td style={{ padding: '6px', textAlign: 'right', color: '#999', fontSize: '12px' }}>
                          {parent.width.toFixed(0)} × {parent.height.toFixed(0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', fontStyle: 'italic' }}>
                  💡 Tell me which parent level number has the correct Y position for the page corner!
                </div>
              </div>
            ) : (
              <div style={{ color: '#ff9800' }}>
                Parent hierarchy not available
              </div>
            )}
          </div>

          {/* Button Positions */}
          <div style={{
            padding: '15px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fafafa'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>
              7. Button Positions
            </h3>
            {data.buttonStates ? (
              <div style={{ fontSize: '14px' }}>
                {/* Academia Button */}
                <div style={{
                  marginBottom: '15px',
                  padding: '10px',
                  background: '#fff',
                  borderRadius: '4px',
                  border: '1px solid #e0e0e0'
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '5px', color: '#1976D2' }}>
                    Academia Button
                  </div>
                  {data.buttonStates.academiaButton ? (
                    <>
                      <div style={{ fontFamily: 'monospace', fontSize: '13px', color: '#333' }}>
                        {formatCoordinates(convertCocoaToAccessibility(data.buttonStates.academiaButton, data.screenHeight))}
                      </div>
                      <div style={{ marginTop: '5px' }}>
                        <strong>Visible:</strong>{' '}
                        <span style={{
                          color: data.buttonStates.academiaButton.isVisible ? '#4CAF50' : '#f44336',
                          fontWeight: 'bold'
                        }}>
                          {data.buttonStates.academiaButton.isVisible ? 'YES' : 'NO'}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div style={{ color: '#ff9800' }}>Button not initialized</div>
                  )}
                </div>

                {/* Count Button */}
                <div style={{
                  padding: '10px',
                  background: '#fff',
                  borderRadius: '4px',
                  border: '1px solid #e0e0e0'
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '5px', color: '#1976D2' }}>
                    Count Button
                  </div>
                  {data.buttonStates.countButton ? (
                    <>
                      <div style={{ fontFamily: 'monospace', fontSize: '13px', color: '#333' }}>
                        {formatCoordinates(convertCocoaToAccessibility(data.buttonStates.countButton, data.screenHeight))}
                      </div>
                      <div style={{ marginTop: '5px' }}>
                        <strong>Visible:</strong>{' '}
                        <span style={{
                          color: data.buttonStates.countButton.isVisible ? '#4CAF50' : '#f44336',
                          fontWeight: 'bold'
                        }}>
                          {data.buttonStates.countButton.isVisible ? 'YES' : 'NO'}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div style={{ color: '#ff9800' }}>Button not initialized</div>
                  )}
                </div>

                <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', fontStyle: 'italic' }}>
                  💡 Note: Coordinates normalized to Accessibility API format (top-left origin)
                </div>
              </div>
            ) : (
              <div style={{ color: '#ff9800' }}>
                Button state data not available
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
          {error ? 'Failed to load position data' : 'Loading position data...'}
        </div>
      )}
    </div>
  );
};

export default PositionDebugger;
