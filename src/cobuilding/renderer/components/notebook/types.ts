export interface NotebookDocument {
  nbformat: number;
  nbformat_minor: number;
  metadata: NotebookMetadata;
  cells: NotebookCell[];
}

export interface NotebookMetadata {
  kernelspec?: {
    name: string;
    display_name: string;
    language?: string;
  };
  language_info?: {
    name: string;
    version?: string;
  };
  [key: string]: unknown;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: CellOutput[];
  execution_count?: number | null;
  id?: string;
}

export type CellOutput =
  | StreamOutput
  | DisplayDataOutput
  | ExecuteResultOutput
  | ErrorOutput;

export interface StreamOutput {
  output_type: 'stream';
  name: 'stdout' | 'stderr';
  text: string[];
}

export interface DisplayDataOutput {
  output_type: 'display_data';
  data: MimeBundle;
  metadata: Record<string, unknown>;
}

export interface ExecuteResultOutput {
  output_type: 'execute_result';
  data: MimeBundle;
  metadata: Record<string, unknown>;
  execution_count: number;
}

export interface ErrorOutput {
  output_type: 'error';
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface MimeBundle {
  'text/plain'?: string[];
  'text/html'?: string[];
  'image/png'?: string;
  'image/svg+xml'?: string[];
  'application/json'?: unknown;
  [key: string]: unknown;
}
