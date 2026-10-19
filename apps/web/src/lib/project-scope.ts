/** 请求按浏览器标签页选择项目；切换时整页重建，丢弃旧请求、侧栏和引用状态。 */
export function projectId(): string {
  const value = new URLSearchParams(location.search).get('project') || 'project_default';
  return /^prj_[a-zA-Z0-9]+$/.test(value) ? value : 'project_default';
}
export function projectPrefix(): string {
  const id = projectId();
  return id === 'project_default' ? '' : '/p/' + id;
}
