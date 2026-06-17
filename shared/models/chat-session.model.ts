export interface ChatMessageHighlight {
  id: string;
  startOffset: number;
  endOffset: number;
  color: string;
}

/** A retrieved chapter that an assistant answer drew on, for clickable citations. */
export interface ChapterCitation {
  n: number;         // citation number referenced inline as [n]
  chapterId: string; // navigate to /chapters/:chapterId/edit
  title: string;
}

/** A map an assistant answer surfaced, shown inline as a clickable thumbnail. */
export interface MapPreview {
  id: string;            // open the full map via /maps/:id
  title: string;
  thumbnailUrl?: string; // auto-generated snapshot; absent until one is captured
}

export interface ChatSessionMessage {
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
  generatingImage?: boolean;
  highlights?: ChatMessageHighlight[];
  sources?: ChapterCitation[];
  maps?: MapPreview[];
}

export interface ChatSession {
  id: string;
  name: string;
  pinned: boolean;
  folderId?: string | null;
  seriesId?: string | null;
  messages: ChatSessionMessage[];
  owner?: string;
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionSummary {
  id: string;
  name: string;
  pinned: boolean;
  folderId?: string | null;
  seriesId?: string | null;
  updatedAt: string;
}

export interface ChatFolder {
  id: string;
  name: string;
  parentFolderId?: string | null;
  seriesId?: string | null;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FolderFile {
  id: string;
  folderId: string;
  name: string;
  blobName: string;
  contentType: string;
  size: number;
  seriesId?: string | null;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}
