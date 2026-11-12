/** A signed-in user the SA screen can offer when granting access. */
export interface KnownUser {
  email: string;
  displayName?: string;
}

export interface SaUsersResponse {
  emails: string[];
  knownUsers: KnownUser[];
}

export interface SaMeResponse {
  isSa: boolean;
}
