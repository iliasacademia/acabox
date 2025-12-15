import React, { useState } from 'react';
import { IPC_CHANNELS } from '../../shared/types';

type IconType = 'dot' | 'gear' | 'bookmark' | 'lock' | 'unlock' | 'add' | 'remove' | 'refresh' | 'text';

interface IconOption {
  type: IconType;
  label: string;
  description: string;
  symbol: string;
}

const iconOptions: IconOption[] = [
  {
    type: 'text',
    label: 'Text (A)',
    description: 'Letter "A" for Academia',
    symbol: 'A'
  },
  {
    type: 'dot',
    label: 'Status Dot',
    description: 'Simple status indicator dot',
    symbol: '●'
  },
  {
    type: 'gear',
    label: 'Gear',
    description: 'Settings or action icon',
    symbol: '⚙'
  },
  {
    type: 'bookmark',
    label: 'Bookmark',
    description: 'Bookmark or saved item',
    symbol: '🔖'
  },
  {
    type: 'lock',
    label: 'Lock',
    description: 'Locked or secure',
    symbol: '🔒'
  },
  {
    type: 'unlock',
    label: 'Unlock',
    description: 'Unlocked or accessible',
    symbol: '🔓'
  },
  {
    type: 'add',
    label: 'Add',
    description: 'Plus sign',
    symbol: '+'
  },
  {
    type: 'remove',
    label: 'Remove',
    description: 'Minus sign',
    symbol: '−'
  },
  {
    type: 'refresh',
    label: 'Refresh',
    description: 'Circular arrow',
    symbol: '↻'
  }
];

const TrayIconSwitcher: React.FC = () => {
  const [currentIcon, setCurrentIcon] = useState<IconType>('text');
  const [status, setStatus] = useState<string>('');

  const handleIconChange = async (iconType: IconType) => {
    setStatus('Changing icon...');
    try {
      const result = await window.electronAPI.invoke(IPC_CHANNELS.CHANGE_TRAY_ICON, iconType);
      if (result.success) {
        setCurrentIcon(iconType);
        const option = iconOptions.find(opt => opt.type === iconType);
        setStatus(`✅ Successfully changed to ${option?.label || iconType}`);
      } else {
        setStatus(`❌ Failed to change icon: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      setStatus(`❌ Error: ${error}`);
    }
  };

  const currentOption = iconOptions.find(opt => opt.type === currentIcon);

  return (
    <div style={{ padding: '20px', maxWidth: '900px', margin: '0 auto' }}>
      <h1>Tray Icon Switcher</h1>
      <p style={{ fontSize: '16px', color: '#666' }}>Choose which icon shape to display in the macOS menu bar:</p>

      <div style={{ margin: '20px 0', padding: '20px', backgroundColor: '#e3f2fd', borderRadius: '8px', border: '2px solid #2196f3' }}>
        <h2 style={{ margin: '0 0 10px 0', fontSize: '20px' }}>
          Current Icon: {currentOption?.label}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              fontSize: '24px',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#fff',
              borderRadius: '4px',
              border: '2px solid #2196f3'
            }}
          >
            {currentOption?.symbol}
          </div>
          <span style={{ color: '#555', fontSize: '15px' }}>{currentOption?.description}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
        {iconOptions.map((option) => (
          <button
            key={option.type}
            onClick={() => handleIconChange(option.type)}
            disabled={currentIcon === option.type}
            style={{
              padding: '15px',
              fontSize: '15px',
              cursor: currentIcon === option.type ? 'not-allowed' : 'pointer',
              opacity: currentIcon === option.type ? 0.6 : 1,
              backgroundColor: currentIcon === option.type ? '#e8f4fd' : '#fff',
              border: currentIcon === option.type ? '3px solid #2196f3' : '2px solid #ddd',
              borderRadius: '8px',
              textAlign: 'center',
              transition: 'all 0.2s',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '10px'
            }}
            onMouseEnter={(e) => {
              if (currentIcon !== option.type) {
                e.currentTarget.style.borderColor = '#2196f3';
                e.currentTarget.style.backgroundColor = '#f5f5f5';
              }
            }}
            onMouseLeave={(e) => {
              if (currentIcon !== option.type) {
                e.currentTarget.style.borderColor = '#ddd';
                e.currentTarget.style.backgroundColor = '#fff';
              }
            }}
          >
            <div
              style={{
                fontSize: '32px',
                width: '48px',
                height: '48px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#f9f9f9',
                borderRadius: '8px',
                border: '1px solid #e0e0e0'
              }}
            >
              {option.symbol}
            </div>
            <div>
              <strong style={{ display: 'block', marginBottom: '4px', fontSize: '16px' }}>{option.label}</strong>
              <div style={{ fontSize: '13px', color: '#666', lineHeight: '1.3' }}>
                {option.description}
              </div>
            </div>
          </button>
        ))}
      </div>

      {status && (
        <div style={{
          padding: '15px',
          backgroundColor: status.includes('✅') ? '#d4edda' : '#f8d7da',
          color: status.includes('✅') ? '#155724' : '#721c24',
          borderRadius: '8px',
          border: `2px solid ${status.includes('✅') ? '#c3e6cb' : '#f5c6cb'}`,
          fontSize: '16px',
          fontWeight: 500
        }}>
          {status}
        </div>
      )}

      <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px solid #dee2e6' }}>
        <h3 style={{ marginTop: 0 }}>About These Icons:</h3>
        <p style={{ margin: '10px 0', lineHeight: '1.6' }}>
          These are <strong>macOS system template icons</strong> with different shapes. They automatically adapt to:
        </p>
        <ul style={{ margin: '10px 0', lineHeight: '1.8' }}>
          <li><strong>Light and dark mode</strong> - Icons appear white on dark menu bars and black on light menu bars</li>
          <li><strong>Menu bar themes</strong> - Matches the system appearance</li>
          <li><strong>Retina displays</strong> - Renders crisply at any resolution</li>
        </ul>
        <p style={{ margin: '15px 0 10px 0', padding: '12px', backgroundColor: '#fff3cd', border: '1px solid #ffeaa7', borderRadius: '4px', fontSize: '14px' }}>
          <strong>Note:</strong> The icons in the menu bar are always <strong>monochrome</strong> (white or black) depending on your menu bar theme.
          The symbols shown here are just visual representations - the actual menu bar icons have distinct shapes but no color.
        </p>
      </div>
    </div>
  );
};

export default TrayIconSwitcher;
