/**
 * 唯一的工具名称与开放条件清单。
 * Bridge 生成 CLI 参数、扩展注册和会话守卫共用它，避免三处清单各自演进。
 * 新增工具先在这里声明，再在 tools/registry.ts 提供注册函数；缺项会被类型检查发现。
 */
const toolPolicy = {
  ta_read_file: { requiresEdit: false },
  ta_list_files: { requiresEdit: false },
  ta_read_context: { requiresEdit: false },
  ta_edit_file: { requiresEdit: true },
} as const;

export type ApprovedToolName = keyof typeof toolPolicy;

/** 返回本次执行可以暴露给模型的工具；真正执行时仍须校验路径和来源。 */
export function getApprovedToolNames(allowEdit: boolean): ApprovedToolName[] {
  return (Object.keys(toolPolicy) as ApprovedToolName[]).filter(
    (name) => allowEdit || !toolPolicy[name].requiresEdit,
  );
}
