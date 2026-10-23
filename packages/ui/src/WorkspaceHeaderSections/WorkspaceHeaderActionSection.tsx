import { MessageCirclePlus } from "lucide-react";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isIdeHost } from "@/lib/ideHost.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  user,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isWebRemoteControl = false,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  isSidebarVisible = true,
  onToggleTerminal,
  onToggleSidePane,
  onToggleSidebar,
  onCreateTask,
  toggleSidePaneShortcutLabel,
  onSelectedEditorChange,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
}: WorkspaceHeaderActionSectionProps) {
  // IDE 宿主没有桌面端的顶部浮层：帮助、终端、右侧面板都是桌面产品入口，
  // 在工具窗口里既用不上又挤占标题区，统一隐藏；右上角只留一个新建对话。
  const ideHost = isIdeHost();
  const { intl } = useZCodeIntl();
  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header 内容区有 p-2，普通工具栏按钮 hover 只覆盖 32px 高度。
        // 标题栏按钮需要抵消这层垂直内边距，和原生窗控/右侧菜单保持同一个 48px hover 面。
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {variant === "task" ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteTarget={remoteTarget}
          onSelectedEditorChange={onSelectedEditorChange}
        />
      ) : null}
      {/* 分享发布接口依赖登录态；未登录时隐藏入口，避免用户打开后只能得到鉴权失败。 */}
      {activeTaskId &&
      user &&
      isDesktop !== false &&
      !isWebRemoteControl &&
      remoteTarget?.kind !== "server" ? (
        <ConversationShareMenu
          taskId={activeTaskId}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {ideHost ? (
        <ControlHintTooltip
          title={intl.formatMessage({ id: "taskList.newThread" })}
          side="bottom"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid="ide-header-new-task"
            className="text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]"
            aria-label={intl.formatMessage({ id: "taskList.newThread" })}
            onClick={() => {
              // 侧栏收起时先展开：新对话落在左侧最近列表里，用户要能看到它。
              if (!isSidebarVisible) onToggleSidebar?.();
              onCreateTask?.();
            }}
          >
            <MessageCirclePlus className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : (
        <>
          {!simplifyForNarrowRemote ? (
            <>
              {!hideHelpMenu ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
              {/* Bugfix: 远程控制移动端头部空间过窄，终端入口在这里会和核心操作争抢宽度。 */}
              <WorkspaceTerminalToggleButton
                isTerminalOpen={isTerminalOpen}
                onToggleTerminal={onToggleTerminal}
                disabledReason={readOnlyReason}
                useWindowsCaptionSpacing={useWindowsCaptionSpacing}
              />
            </>
          ) : null}
          {/* 远程控制移动端只保留图标，避免 diff 数字把按钮撑宽导致标题拥挤。 */}
          {!isSidePaneOpen ? (
            <WorkspaceSidePaneToggleButton
              isSidePaneOpen={isSidePaneOpen}
              onToggleSidePane={onToggleSidePane}
              shortcutLabel={toggleSidePaneShortcutLabel}
              useWindowsCaptionSpacing={useWindowsCaptionSpacing}
            />
          ) : null}
        </>
      )}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
