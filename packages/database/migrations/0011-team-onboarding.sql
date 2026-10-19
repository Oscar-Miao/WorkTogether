-- 默认项目资格只迁移一次，重启不得接纳新注册账号。
CREATE TABLE identity_settings(id boolean PRIMARY KEY DEFAULT true CHECK(id),legacy_membership_migrated boolean NOT NULL DEFAULT false);
INSERT INTO identity_settings(id) VALUES(true);
CREATE TABLE identity_rate_limits(bucket text PRIMARY KEY,count integer NOT NULL,reset_at timestamptz NOT NULL);
CREATE TABLE org_invitations(
 id text PRIMARY KEY,token_hash text NOT NULL UNIQUE,project_id text NOT NULL REFERENCES org_projects(id),
 email text,max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 100),used_count integer NOT NULL DEFAULT 0 CHECK(used_count>=0 AND used_count<=max_uses),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE org_invite_acceptances(invitation_id text NOT NULL REFERENCES org_invitations(id),user_id text NOT NULL REFERENCES users(id),accepted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(invitation_id,user_id));
CREATE INDEX org_invitation_project ON org_invitations(project_id,created_at);
-- 子项目只含同步后的项目身份；根数据库兼存全站身份，名册须排除其他团队账号。
CREATE VIEW project_users AS SELECT u.* FROM users u WHERE NOT EXISTS(SELECT 1 FROM org_workspaces)
 OR EXISTS(SELECT 1 FROM org_project_members m WHERE m.project_id='project_default' AND m.user_id=u.id);
