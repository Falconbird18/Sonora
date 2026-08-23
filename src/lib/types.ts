export interface ScoreItem {
  id: string;
  title: string;
  composer: string;
  pdfBlob: Blob;
  thumbnailUrl?: string;
  totalPages: number;
  addedAt: number;
}

export interface Point { x: number; y: number; }

export interface Stroke {
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: Point[];
}

export interface SymbolStamp {
  id: string;
  symbol: string;
  label: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

export interface TextNote {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

export interface AnnotationRecord {
  id: string; // `${scoreId}_page_${pageNum}`
  scoreId: string;
  pageNum: number;
  strokes: Stroke[];
  stamps: SymbolStamp[];
  notes: TextNote[];
}
