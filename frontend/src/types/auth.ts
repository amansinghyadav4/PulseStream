export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  created_at: string;
  organization: Organization;
}

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";
