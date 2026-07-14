export interface TurtleChatMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: KBAction[];
}

export type GraphFilter = 'hubs' | 'islands' | 'leaps' | 'confirmed' | 'pending' | 'no-type' | 'no-source';

export type KBAction =
  | { type: 'add_triple'; s: string; p: string; o: string; label: string }
  | { type: 'remove_triple'; s: string; p: string; o: string; label: string }
  | { type: 'set_type'; entityIri: string; entityLabel: string; typeIri: string; typeLabel: string }
  | { type: 'merge_entities'; keepEntityIri: string; keepEntityLabel: string; dropEntityIri: string; dropEntityLabel: string }
  | { type: 'confirm_source'; sourceId: string; sourceTitle: string }
  // 'timeline' and 'hierarchy' were missing while KnowledgeGraph rendered both — so the single
  // most obvious thing to offer someone staring at dated facts ("want to see these on a
  // timeline?") was not expressible in the view-control API. A view-control API that cannot
  // express the view is not an API.
  | { type: 'adjust_view'; selectEntity?: string; layout?: 'force' | 'focus' | 'source' | 'type' | 'hub' | 'timeline' | 'order' | 'hierarchy'; filters?: GraphFilter[]; label: string }
  | { type: 'query_kb'; filter: 'no-type' | 'no-source' | 'pending' | 'islands'; label: string }
  | { type: 'scrape_url'; url: string; label: string };

export interface TurtleChatRequest {
  apiKey: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  kbContext: KBContext;
}

export interface KBContext {
  statementCount: number;
  sourceCount: number;
  typesPresent: string[];
  untypedEntityCount: number;
  manualStatementCount: number;
  sampleEntities: Array<{ iri: string; label: string; type: string | null; predicates: string[] }>;
  /**
   * Present when the toured KB is a visual-test story — TestStep / story:Step
   * nodes that carry a screenshot (kmeta:gif / icon2d) plus an assertion and a
   * result verdict. Its presence flips Shelly from "explore" to "visual review":
   * walk the steps in order, put each screenshot front-and-centre, read the
   * assertion + verdict, and ask the reviewer to confirm or flag. (F34)
   */
  reviewSteps?: Array<{
    iri: string;
    order: number;
    title: string;
    assertion: string | null;
    result: string | null;
    page: string | null;
    hasScreenshot: boolean;
  }>;
}

export interface TurtleChatResponse {
  message: string;
  actions: KBAction[];
}
