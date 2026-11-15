export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  isActive?: boolean;
}

export function createUserProfile(input: UserProfile): UserProfile {
  return {
    ...input,
    isActive: input.isActive ?? true,
  };
}
