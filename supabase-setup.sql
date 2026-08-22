-- 吉吉利利 · Supabase 多用户同步数据库脚本
-- 说明：以 "家庭码" 作为唯一共享凭证，同一家庭码下的所有用户看到同一份数据。
-- 运行方式：在 Supabase Dashboard → SQL Editor → New query，粘贴后点击 Run。

-- 1. 创建家庭数据表
CREATE TABLE IF NOT EXISTS families (
  code TEXT PRIMARY KEY,                     -- 家庭码，如 li2026（建议 6~8 位字母数字）
  data JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 存储 App 全部状态（冰箱/食谱/待办等）
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 更新时间戳自动刷新
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_timestamp ON families;
CREATE TRIGGER set_timestamp
  BEFORE UPDATE ON families
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_timestamp();

-- 3. 把表加入 realtime 发布，让客户端能收到实时更新
ALTER PUBLICATION supabase_realtime ADD TABLE families;

-- 4.（可选）RLS：如果希望任何人知道家庭码就能读写，可跳过本节；
--    若希望匿名用户只能读写自己的家庭码，请改用 RLS 策略。
--    本项目当前设计：家庭码即共享密钥，不额外启用 RLS，便于实时同步。
