-- Row-Level Security (RLS)
-- Note: RLS requires Supabase or an environment configured with auth.uid()
-- Local development can skip RLS, only enable in production

-- ALTER TABLE normalized_messages ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE machines ENABLE ROW LEVEL SECURITY;

-- Admins can access all data
-- CREATE POLICY "admin_full_access" ON normalized_messages
--   FOR ALL USING (
--     EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('super_admin', 'admin'))
--   );

-- Regular users can only see data from devices assigned to them
-- CREATE POLICY "user_own_devices" ON normalized_messages
--   FOR SELECT USING (
--     machine_id IN (SELECT id FROM machines WHERE owner_id = auth.uid())
--   );

-- Device management table policy
-- CREATE POLICY "admin_manage_devices" ON machines
--   FOR ALL USING (
--     EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('super_admin', 'admin'))
--   );
