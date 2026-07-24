import React, { useState, useEffect } from 'react';
import { AcaboxMark } from './AcaboxMark';

/**
 * The 40px window-chrome bar. With `titleBarStyle: 'hiddenInset'` on the main
 * window this IS the title bar: the whole strip is a drag region and the
 * native traffic lights sit in the left inset (cleared by CSS padding).
 *
 * Health = agent-server liveness via containerAPI.status(), polled.
 */
export function ChromeBar({ right }: { right?: React.ReactNode }) {
  const [running, setRunning] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      window.containerAPI
        .status()
        .then((s) => { if (alive) setRunning(s.running); })
        .catch(() => { if (alive) setRunning(false); });
    };
    poll();
    const timer = setInterval(poll, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const version = process.env.APP_VERSION || '0.0.0';

  return (
    <div className="cdChrome">
      <div className="cdChrome__title">
        <AcaboxMark size={16} className="cdChrome__mark" />
        <span>ACABOX — LOCAL VM · V{version}</span>
      </div>
      <div className="cdChrome__right">
        {right}
        <span className="cdChrome__health">
          <span
            className="cdDot"
            style={{ background: running ? 'var(--cd-success)' : 'var(--cd-busy)' }}
          />
          {running ? 'HEALTHY' : 'STARTING'}
        </span>
      </div>
    </div>
  );
}
