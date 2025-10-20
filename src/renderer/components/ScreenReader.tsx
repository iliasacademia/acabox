import React, { useState, useRef, useEffect } from 'react';

interface Source {
  id: string;
  name: string;
}

const ScreenReader: React.FC = () => {
  const [isEnabled, setIsEnabled] = useState(false);
  const [status, setStatus] = useState('Disabled');
  const [wordContent, setWordContent] = useState<string>('');
  const [lastReadTime, setLastReadTime] = useState<string | null>(null);
  const [windowBounds, setWindowBounds] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [wordApiTestResult, setWordApiTestResult] = useState<string>('');
  const [availableSources, setAvailableSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState<Source | null>(null);
  const [capturedScreenshot, setCapturedScreenshot] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenshotCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const changeDetectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const visibilityCheckRef = useRef<NodeJS.Timeout | null>(null);
  const lastWindowBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const lastScrollPositionRef = useRef<number | null>(null);
  const isWordFrontmostRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      stopWordReader();
    };
  }, []);

  const toggleScreenReader = async () => {
    if (isEnabled) {
      stopWordReader();
    } else {
      await startWordReader();
    }
  };

  const startWordReader = async () => {
    try {
      setStatus('Fetching available sources...');
      setIsEnabled(true);

      // Get all available screen and window sources
      const rawSources = await window.electronAPI.invoke('get-all-sources');
      if (!rawSources || rawSources.length === 0) {
        setStatus('No sources available');
        setIsEnabled(false);
        return;
      }

      // Map to simplified Source interface
      const sources: Source[] = rawSources.map((source: any) => ({
        id: source.id,
        name: source.name,
      }));

      setAvailableSources(sources);
      setStatus(`Found ${sources.length} available sources. Please select one.`);
    } catch (error) {
      console.error('Error starting Word reader:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsEnabled(false);
    }
  };

  const stopWordReader = () => {
    // Stop the change detection interval
    if (changeDetectionIntervalRef.current) {
      clearInterval(changeDetectionIntervalRef.current);
      changeDetectionIntervalRef.current = null;
    }

    // Stop the visibility check interval
    if (visibilityCheckRef.current) {
      clearInterval(visibilityCheckRef.current);
      visibilityCheckRef.current = null;
    }

    // Clear last known state
    lastWindowBoundsRef.current = null;
    lastScrollPositionRef.current = null;
    isWordFrontmostRef.current = false;

    // Stop the media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Clear video source
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsEnabled(false);
    setStatus('Disabled');
    setWordContent('');
    setLastReadTime(null);
    setWindowBounds(null);
    setAvailableSources([]);
    setSelectedSource(null);
    setCapturedScreenshot(null);
  };

  const handleSourceSelection = async (source: Source) => {
    try {
      setSelectedSource(source);
      setStatus(`Capturing screenshot of "${source.name}"...`);

      // Get media stream for the selected source
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // @ts-ignore - Electron specific constraint
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
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
        await videoRef.current.play();

        // Wait for video to be ready
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Capture screenshot
        if (screenshotCanvasRef.current && videoRef.current) {
          const video = videoRef.current;
          const canvas = screenshotCanvasRef.current;
          const context = canvas.getContext('2d');

          if (context && video.videoWidth && video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);

            const screenshotData = canvas.toDataURL('image/png');
            setCapturedScreenshot(screenshotData);
            setStatus(`Screenshot captured of "${source.name}"`);
          }
        }

        // Stop the stream after capturing
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
      }
    } catch (error) {
      console.error('Error capturing screenshot:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const testWordApi = async () => {
    try {
      console.log('Testing Word API...');
      const result = await window.electronAPI.invoke('test-word-api');

      if (result.success) {
        console.log('Word API test succeeded!');
        console.log(result.result);
        setWordApiTestResult(result.result);
      } else {
        console.error('Word API test failed:', result.error);
        setWordApiTestResult(`Error: ${result.error}`);
      }
    } catch (error) {
      console.error('Error testing Word API:', error);
      setWordApiTestResult(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const checkForChanges = async () => {
    try {
      // Check if Word is frontmost
      const frontmostCheck = await window.electronAPI.invoke('check-word-frontmost');
      if (!frontmostCheck.success || !frontmostCheck.isFrontmost) {
        // Word not frontmost, don't check for changes
        return;
      }

      const currentBounds = frontmostCheck.windowBounds;
      if (!currentBounds) return;

      // Check if window bounds changed
      let windowChanged = false;
      const isFirstCheck = !lastWindowBoundsRef.current;

      if (isFirstCheck) {
        windowChanged = true; // First time
        lastWindowBoundsRef.current = currentBounds;
      } else {
        const prev = lastWindowBoundsRef.current;
        if (prev) {
          windowChanged =
            prev.x !== currentBounds.x ||
            prev.y !== currentBounds.y ||
            prev.width !== currentBounds.width ||
            prev.height !== currentBounds.height;

          if (windowChanged) {
            lastWindowBoundsRef.current = currentBounds;
          }
        }
      }

      // Check if scroll position changed
      let scrollChanged = false;
      const scrollResult = await window.electronAPI.invoke('get-word-scroll-position');
      if (scrollResult.success) {
        const currentScroll = scrollResult.scrollPosition;
        if (lastScrollPositionRef.current === null) {
          scrollChanged = isFirstCheck; // Only trigger on first check if window also changed
          lastScrollPositionRef.current = currentScroll;
        } else {
          // Consider it changed if scroll position differs by more than 10 characters
          scrollChanged = Math.abs(currentScroll - lastScrollPositionRef.current) > 10;
          if (scrollChanged) {
            lastScrollPositionRef.current = currentScroll;
          }
        }
      }

      // If either changed, trigger a scan
      if (windowChanged || scrollChanged) {
        console.log('Change detected:', { windowChanged, scrollChanged });
        await captureAndProcessWord();
      }
    } catch (error) {
      console.error('Error checking for changes:', error);
    }
  };

  const captureAndProcessWord = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    // Check if Word is frontmost before capturing
    const frontmostCheck = await window.electronAPI.invoke('check-word-frontmost');
    if (!frontmostCheck.success || !frontmostCheck.isFrontmost) {
      setStatus('Waiting for Microsoft Word to be the active window...');
      return;
    }

    // Update window bounds from the frontmost check
    const updatedBounds = frontmostCheck.windowBounds;
    if (!updatedBounds) return;

    setWindowBounds(updatedBounds);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');

    if (!context) return;

    // Check if video is ready and has valid dimensions
    if (!video.videoWidth || !video.videoHeight) {
      console.log('Video not ready yet, skipping capture');
      return;
    }

    // Update content if Word is now frontmost
    if (!wordContent) {
      try {
        const contentResult = await window.electronAPI.invoke('get-word-content');
        if (contentResult.success && contentResult.content) {
          setWordContent(contentResult.content);
        }
      } catch (err) {
        console.log('Could not get Word content yet');
      }
    }

    setLastReadTime(new Date().toLocaleTimeString());
    setStatus('Word reader enabled - Drawing underlines...');

    try {
      // Calculate scale factors to map window bounds to video coordinates
      const primaryDisplay = await window.electronAPI.invoke('get-screen-sources');
      const scaleX = video.videoWidth / window.screen.width;
      const scaleY = video.videoHeight / window.screen.height;

      // Calculate Word window position in video coordinates
      const wordWindowInVideo = {
        x: updatedBounds.x * scaleX,
        y: updatedBounds.y * scaleY,
        width: updatedBounds.width * scaleX,
        height: updatedBounds.height * scaleY,
      };

      console.log('Window bounds (screen):', updatedBounds);
      console.log('Window bounds (video):', wordWindowInVideo);
      console.log('Scale factors:', { scaleX, scaleY });

      // Set canvas size to match Word window only
      canvas.width = wordWindowInVideo.width;
      canvas.height = wordWindowInVideo.height;

      // Draw only the Word window portion from the video
      context.drawImage(
        video,
        wordWindowInVideo.x, wordWindowInVideo.y, wordWindowInVideo.width, wordWindowInVideo.height,
        0, 0, canvas.width, canvas.height
      );

      // Get image data as base64 (now only contains Word window)
      const imageData = canvas.toDataURL('image/png');

      console.log('Sending cropped Word window image to OCR');
      console.log('Cropped canvas size:', { width: canvas.width, height: canvas.height });

      // Send to main process for OCR with Word window bounds and cropped dimensions
      const result = await window.electronAPI.invoke('process-word-window', imageData, updatedBounds, {
        width: canvas.width,
        height: canvas.height,
      });

      console.log('OCR result:', result);

      // Count total occurrences in full document
      const searchTerm = 'academia';
      const totalMatches = (wordContent.toLowerCase().match(new RegExp(searchTerm, 'g')) || []).length;

      if (result.matches && result.matches.length > 0) {
        console.log('Found matches:', result.matches);
        setStatus(`Found ${result.matches.length} visible of ${totalMatches} total occurrence(s) of "Academia"`);
      } else {
        console.log('No matches found in visible area');
        setStatus(`Scanning... (0 visible of ${totalMatches} total matches)`);
      }
    } catch (error) {
      console.error('Error processing Word window:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>Screen Reader</h1>
      <p>
        Select a screen or window to capture and display.
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

      {/* Available sources list */}
      {isEnabled && availableSources.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <h2>Available Sources</h2>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            marginTop: '10px'
          }}>
            {availableSources.map((source) => (
              <div
                key={source.id}
                onClick={() => handleSourceSelection(source)}
                style={{
                  border: selectedSource?.id === source.id ? '3px solid #007bff' : '1px solid #ddd',
                  borderRadius: '8px',
                  padding: '15px',
                  cursor: 'pointer',
                  backgroundColor: selectedSource?.id === source.id ? '#e7f3ff' : 'white',
                  transition: 'all 0.2s',
                }}
              >
                <div style={{ fontSize: '16px', fontWeight: 'bold' }}>
                  {source.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Captured screenshot display */}
      {capturedScreenshot && (
        <div style={{ marginTop: '30px' }}>
          <h2>Captured Screenshot</h2>
          <div style={{
            marginTop: '10px',
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '10px',
            backgroundColor: '#f9f9f9'
          }}>
            <img
              src={capturedScreenshot}
              alt="Captured screenshot"
              style={{
                width: '100%',
                height: 'auto',
                borderRadius: '4px',
              }}
            />
          </div>
        </div>
      )}

      {/* Hidden video and canvas elements for screen capture */}
      <div style={{ display: 'none' }}>
        <video ref={videoRef} />
        <canvas ref={canvasRef} />
        <canvas ref={screenshotCanvasRef} />
      </div>
    </div>
  );
};

export default ScreenReader;
