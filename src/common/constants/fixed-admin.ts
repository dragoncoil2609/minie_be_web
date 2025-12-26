export const FIXED_ADMIN_EMAIL = 'admin@admin.com';
export const FIXED_ADMIN_PASSWORD = '@Ngulon123';
export const FIXED_ADMIN_NAME = FIXED_ADMIN_EMAIL;

export function isFixedAdminEmail(email?: string | null) {
  return (email ?? '').trim().toLowerCase() === FIXED_ADMIN_EMAIL;
}


