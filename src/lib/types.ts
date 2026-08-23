export interface ScoreItem {
  id: string; title: string; composer: string; pdfBlob: Blob; thumbnailUrl?: string; totalPages: number; addedAt: number; lastOpenedAt?: number; favorite?: boolean; tags?: string[]; collection?: string;
}
export interface Point { x:number; y:number; pressure?:number; }
export interface Stroke { id?:string; tool:'pen'|'highlighter'; kind?:'freehand'|'line'|'arrow'; color:string; width:number; points:Point[]; }
export interface SymbolStamp { id:string; symbol:string; label:string; x:number; y:number; fontSize:number; color:string; }
export interface TextNote { id:string; text:string; x:number; y:number; fontSize:number; color:string; }
export interface AnnotationRecord { id:string; scoreId:string; pageNum:number; strokes:Stroke[]; stamps:SymbolStamp[]; notes:TextNote[]; }
