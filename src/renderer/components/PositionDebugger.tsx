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

interface FirstTextAreaInfo {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  charCount: number;
}

interface BadgeState {
  count: number;
  isVisible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NotificationItem {
  id: number;
  title: string;
  body_html: string;
  user_id: number;
  status: 'unread' | 'read' | 'dismissed';
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
  dismissed_at: number | null;
}

interface NotificationBreakdown {
  unread: number;
  read: number;
  dismissed: number;
  total: number;
}

interface PositionDebugData {
  documentTopLeftCorner: Position | null;
  wordWindowBounds: Bounds | null;
  firstLinePosition: Bounds | null;
  pageCornerVisibility: PageCornerVisibility | null;
  parentHierarchy: ParentElement[];
  buttonStates: ButtonStates | null;
  scrollAreaBounds: Bounds | null;
  firstTextAreaInfo: FirstTextAreaInfo | null;
  badgeState: BadgeState | null;
  notifications: NotificationItem[];
  notificationBreakdown: NotificationBreakdown;
  currentUserId: number | null;
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
      // Fetch both position data and notifications in parallel
      const [positionResult, notificationsResult] = await Promise.all([
        window.electronAPI.invoke('get-position-debug-info'),
        window.electronAPI.invoke('get-all-notifications')
      ]);

      if (positionResult.success && notificationsResult.success) {
        // Merge the results
        setData({
          ...positionResult.data,
          notifications: notificationsResult.notifications,
          notificationBreakdown: notificationsResult.breakdown,
          currentUserId: notificationsResult.currentUserId
        });
        setLastUpdateTime(new Date().toLocaleTimeString());
        setError(null);
      } else {
        setError(positionResult.error || notificationsResult.error || 'Failed to get data');
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

          {/* First TextArea Info */}
          <div style={{
            padding: '15px',
            border: '2px solid #2196F3',
            borderRadius: '4px',
            background: '#e3f2fd'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#1565C0' }}>
              7. First TextArea (Full Content)
            </h3>
            {data.firstTextAreaInfo ? (
              <div style={{ fontSize: '14px' }}>
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ fontFamily: 'monospace', fontSize: '14px', marginBottom: '5px' }}>
                    <strong>Position & Size:</strong> {formatCoordinates(data.firstTextAreaInfo)}
                  </div>
                  <div style={{ fontSize: '14px', marginBottom: '10px' }}>
                    <strong>Character Count:</strong> {data.firstTextAreaInfo.charCount.toLocaleString()} characters
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>
                    Text Content:
                  </div>
                  <div style={{
                    padding: '10px',
                    background: '#fff',
                    border: '1px solid #90CAF9',
                    borderRadius: '4px',
                    maxHeight: '300px',
                    overflowY: 'auto',
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    lineHeight: '1.5',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}>
                    {data.firstTextAreaInfo.text || '(empty)'}
                  </div>
                </div>
                {data.firstTextAreaInfo.text.length > 1000 && (
                  <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', fontStyle: 'italic' }}>
                    💡 Showing {data.firstTextAreaInfo.text.length} characters (scroll to view all)
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: '#ff9800' }}>
                First TextArea info not available (document may not have focus)
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
              8. Button Positions
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

          {/* Notification Badge */}
          <div style={{
            padding: '15px',
            border: '2px solid #ff9800',
            borderRadius: '4px',
            background: '#fff8e1'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#e65100' }}>
              9. Notification Badge
            </h3>
            {data.badgeState ? (
              <div style={{ fontSize: '14px' }}>
                <div style={{ marginBottom: '8px' }}>
                  <strong>Count:</strong> {data.badgeState.count}
                </div>
                <div style={{ marginBottom: '8px' }}>
                  <strong>Visible:</strong>{' '}
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: '3px',
                    background: data.badgeState.isVisible ? '#4caf50' : '#f44336',
                    color: 'white',
                    fontWeight: 'bold'
                  }}>
                    {data.badgeState.isVisible ? 'YES' : 'NO'}
                  </span>
                </div>
                <div style={{ marginBottom: '8px' }}>
                  <strong>Position:</strong> x={data.badgeState.x.toFixed(1)}, y={data.badgeState.y.toFixed(1)}
                </div>
                <div style={{ marginBottom: '8px' }}>
                  <strong>Size:</strong> {data.badgeState.width.toFixed(1)} × {data.badgeState.height.toFixed(1)}
                </div>
                <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', fontStyle: 'italic' }}>
                  💡 Note: Badge is positioned relative to the Academia button frame
                </div>
              </div>
            ) : (
              <div style={{ color: '#ff9800' }}>
                Badge state data not available (button may not be initialized or no notifications)
              </div>
            )}
          </div>

          {/* All Notifications */}
          <div style={{
            padding: '15px',
            border: '2px solid #2196f3',
            borderRadius: '4px',
            background: '#e3f2fd'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#1565c0' }}>
              10. All Notifications
            </h3>
            {data.notifications && data.notifications.length > 0 ? (
              <div style={{ fontSize: '14px' }}>
                {/* Summary */}
                <div style={{ marginBottom: '15px', padding: '10px', background: '#fff', borderRadius: '4px' }}>
                  <div><strong>Current User ID:</strong> {data.currentUserId}</div>
                  <div><strong>Total Notifications:</strong> {data.notificationBreakdown.total}</div>
                  <div style={{ marginTop: '8px', display: 'flex', gap: '15px' }}>
                    <span style={{ color: '#2196f3' }}>
                      <strong>Unread:</strong> {data.notificationBreakdown.unread}
                    </span>
                    <span style={{ color: '#4caf50' }}>
                      <strong>Read:</strong> {data.notificationBreakdown.read}
                    </span>
                    <span style={{ color: '#9e9e9e' }}>
                      <strong>Dismissed:</strong> {data.notificationBreakdown.dismissed}
                    </span>
                  </div>
                </div>

                {/* Notifications Table */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    background: '#fff',
                    fontSize: '12px'
                  }}>
                    <thead>
                      <tr style={{ background: '#1565c0', color: 'white' }}>
                        <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #ddd' }}>ID</th>
                        <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #ddd' }}>Title</th>
                        <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #ddd' }}>Status</th>
                        <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #ddd' }}>User ID</th>
                        <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #ddd' }}>Created</th>
                        <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #ddd' }}>Delivered</th>
                        <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #ddd' }}>Read</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.notifications.map((notif) => (
                        <tr key={notif.id} style={{ borderBottom: '1px solid #ddd' }}>
                          <td style={{ padding: '8px', border: '1px solid #ddd' }}>{notif.id}</td>
                          <td style={{ padding: '8px', border: '1px solid #ddd' }}>
                            {notif.title.length > 40 ? notif.title.substring(0, 40) + '...' : notif.title}
                          </td>
                          <td style={{ padding: '8px', border: '1px solid #ddd' }}>
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: '3px',
                              background: notif.status === 'unread' ? '#2196f3' :
                                         notif.status === 'read' ? '#4caf50' : '#9e9e9e',
                              color: 'white',
                              fontWeight: 'bold',
                              fontSize: '11px'
                            }}>
                              {notif.status.toUpperCase()}
                            </span>
                          </td>
                          <td style={{ padding: '8px', border: '1px solid #ddd' }}>{notif.user_id}</td>
                          <td style={{ padding: '8px', border: '1px solid #ddd' }}>
                            {new Date(notif.created_at).toLocaleString()}
                          </td>
                          <td style={{ padding: '8px', border: '1px solid #ddd' }}>
                            {notif.delivered_at ? new Date(notif.delivered_at).toLocaleString() : 'Not delivered'}
                          </td>
                          <td style={{ padding: '8px', border: '1px solid #ddd' }}>
                            {notif.read_at ? new Date(notif.read_at).toLocaleString() : 'Not read'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div style={{ color: '#1565c0' }}>
                {data.currentUserId ?
                  `No notifications found for user ${data.currentUserId}` :
                  'No user logged in or no notifications available'}
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
