import React, { type FC } from 'react';
import anser from 'anser';
import DOMPurify from 'isomorphic-dompurify';
import type { CellOutput as CellOutputType, MimeBundle } from './types';

export const CellOutput: FC<{ output: CellOutputType }> = ({ output }) => {
  switch (output.output_type) {
    case 'stream': {
      const text = output.text.join('');
      const html = anser.ansiToHtml(text, { use_classes: false });
      return (
        <pre
          className={`cellOutputStream ${output.name === 'stderr' ? 'cellOutputStream--stderr' : ''}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }

    case 'execute_result':
    case 'display_data':
      return <MimeBundleRenderer data={output.data} />;

    case 'error':
      return (
        <pre className="cellOutputError">
          {output.traceback.map((line, i) => {
            const html = anser.ansiToHtml(line, { use_classes: false });
            return (
              <span
                key={i}
                dangerouslySetInnerHTML={{ __html: html + '\n' }}
              />
            );
          })}
        </pre>
      );

    default:
      return null;
  }
};

const MimeBundleRenderer: FC<{ data: MimeBundle }> = ({ data }) => {
  if (data['image/png']) {
    return (
      <div className="cellOutputImage">
        <img
          src={`data:image/png;base64,${data['image/png']}`}
          alt="output"
        />
      </div>
    );
  }

  if (data['image/svg+xml']) {
    const svg = Array.isArray(data['image/svg+xml'])
      ? data['image/svg+xml'].join('')
      : String(data['image/svg+xml']);
    return (
      <div
        className="cellOutputResult"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg) }}
      />
    );
  }

  if (data['text/html']) {
    const html = Array.isArray(data['text/html'])
      ? data['text/html'].join('')
      : String(data['text/html']);
    return (
      <div
        className="cellOutputResult cellOutputResult--html"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
      />
    );
  }

  if (data['text/plain']) {
    const text = Array.isArray(data['text/plain'])
      ? data['text/plain'].join('')
      : String(data['text/plain']);
    return (
      <pre className="cellOutputStream">{text}</pre>
    );
  }

  return null;
};
