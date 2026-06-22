export interface SessionID {
  character_id: string;
  chat_id: string;
  branch_id: string;
}

export interface Session {
  id: string;
  character_id: string;
  chat_id: string;
  branch_id: string;
  round: number;
  created_at: number;
  last_active_at: number;
  /** 上次提取的消息指纹 (SHA256 前16位)，用于增量提取 */
  last_fingerprint: string;
  /** 上次提取时的消息总数，用于快速判断 */
  last_message_count: number;
  /** 全量消息完整性哈希（采样），用于检测删除/swipe */
  last_integrity_hash: string;
}
