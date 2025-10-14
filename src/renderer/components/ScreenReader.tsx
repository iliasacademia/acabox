import React, { useState, useRef, useEffect } from 'react';

const ScreenReader: React.FC = () => {
  const [isEnabled, setIsEnabled] = useState(false);
  const [status, setStatus] = useState('Disabled');
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [lastCaptureTime, setLastCaptureTime] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      stopScreenCapture();
    };
  }, []);

  const toggleScreenReader = async () => {
    if (isEnabled) {
      stopScreenCapture();
    } else {
      await startScreenCapture();
    }
  };

  const startScreenCapture = async () => {
    try {
      setStatus('Requesting screen access...');

      // Get available sources using desktopCapturer
      const sources = await window.electronAPI.invoke('get-screen-sources');

      if (!sources || sources.length === 0) {
        setStatus('No screen sources available');
        return;
      }

      // Use the first screen source (primary display)
      const primarySource = sources[0];

      // Get media stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // @ts-ignore - Electron specific constraint
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: primarySource.id,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080,
          },
        },
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      setIsEnabled(true);
      setStatus('Screen reader enabled - Scanning for "Academia"...');

      // Wait for video to be ready before first capture
      setTimeout(() => {
        captureAndProcess();
      }, 1000);

      // Start capturing frames every minute (60000ms)
      intervalRef.current = setInterval(() => {
        captureAndProcess();
      }, 60000);
    } catch (error) {
      console.error('Error starting screen capture:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsEnabled(false);
    }
  };

  const stopScreenCapture = () => {
    // Stop the interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Stop the media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Clear video source
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    // Close overlay window
    window.electronAPI.invoke('close-overlay');

    setIsEnabled(false);
    setStatus('Disabled');
    setCapturedImage(null);
    setLastCaptureTime(null);
  };

  const captureAndProcess = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');

    if (!context) return;

    // Check if video is ready and has valid dimensions
    if (!video.videoWidth || !video.videoHeight) {
      console.log('Video not ready yet, skipping capture');
      return;
    }

    // Set canvas size to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Draw current video frame to canvas
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Get image data as base64
    const imageData = canvas.toDataURL('image/png');

    // Update the captured image in UI
    setCapturedImage(imageData);
    setLastCaptureTime(new Date().toLocaleTimeString());

    try {
      // Send to main process for OCR with video dimensions
      const result = await window.electronAPI.invoke('process-screen-ocr', imageData, {
        width: video.videoWidth,
        height: video.videoHeight,
      });

      if (result.matches && result.matches.length > 0) {
        setStatus(`Found ${result.matches.length} occurrence(s) of "Academia"`);
      } else {
        setStatus('Scanning... (no matches)');
      }
    } catch (error) {
      console.error('Error processing OCR:', error);
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>Screen Reader</h1>
      <p>
        This feature captures your screen and highlights the word "Academia" when detected.
      </p>

      <div style={{ marginTop: '20px' }}>
        <button
          onClick={toggleScreenReader}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: isEnabled ? '#dc3545' : '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
          }}
        >
          {isEnabled ? 'Disable' : 'Enable'} Screen Reader
        </button>
      </div>

      <div style={{ marginTop: '20px' }}>
        <strong>Status:</strong> {status}
      </div>

      {lastCaptureTime && (
        <div style={{ marginTop: '10px' }}>
          <strong>Last capture:</strong> {lastCaptureTime}
        </div>
      )}

      {/* Display captured image */}
      {capturedImage && (
        <div style={{ marginTop: '20px' }}>
          <h3>Captured Screen</h3>
          <img
            src={capturedImage}
            alt="Captured screen"
            style={{
              maxWidth: '100%',
              border: '2px solid #ccc',
              borderRadius: '5px',
              marginTop: '10px',
            }}
          />
        </div>
      )}

      {/* Hidden video and canvas elements for screen capture */}
      <div style={{ display: 'none' }}>
        <video ref={videoRef} />
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
};

export default ScreenReader;
