import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GuardManifest } from '../guard-manifest.js';
import { getApprovedToolNames, type ApprovedToolName } from '../tool-policy.js';
import { registerReadFileTool } from './filesystem/read-file.js';
import { registerListFilesTool } from './filesystem/list-files.js';
import { registerEditFileTool } from './filesystem/edit-file.js';
import { registerReadContextTool } from './context/read-context.js';
import type { ToolRegistrar } from './shared.js';

// Record 要求清单中的每个工具都有实现，避免新增名称后忘记接线。
const registrars: Record<ApprovedToolName, ToolRegistrar> = {
  ta_read_file: registerReadFileTool,
  ta_list_files: registerListFilesTool,
  ta_read_context: registerReadContextTool,
  ta_edit_file: registerEditFileTool,
};

/** 显式注册受版本管理的工具，不扫描目录或自动加载外部脚本。 */
export function registerApprovedTools(pi: ExtensionAPI, manifest: GuardManifest) {
  const active = getApprovedToolNames(manifest.allowEdit);
  for (const name of active) registrars[name](pi, manifest);
  return active;
}
