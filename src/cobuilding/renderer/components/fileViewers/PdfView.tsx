import React, { type FC } from 'react';

interface PdfViewProps {
  fileUrl: string;
}

export const PdfView: FC<PdfViewProps> = ({ fileUrl }) => {
  // Chromium ships a built-in PDF viewer; loading via <iframe> gives us
  // zoom, page navigation, and search for free.
  return <iframe src={fileUrl} title="PDF preview" className="pdfViewIframe" />;
};
