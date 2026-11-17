import { IconMenuOutline20, IconNewChatOutline20 } from "../base/icons.js";
import { useTranslate } from "../../i18n/index.js";
import { newChat } from "../../services/chat/store.js";
import { ProjectLink } from "../base/ProjectLink.js";
import { IconButton } from "../base/IconButton.js";
import { openMobileSider } from "../sider/mobileSiderState.js";
import styles from "./MobileHeader.module.css";

/** 移动端顶栏：左侧菜单打开侧边栏，首页显示应用名，会话页显示标题和新对话按钮 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate();
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t("expandSiderbarButton")}
        onClick={openMobileSider}
      />
      {title === undefined ? (
        <ProjectLink className={styles.title} iconSize={26} />
      ) : (
        <div className={styles.title}>{title}</div>
      )}
      {title !== undefined ? (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t("newChat")}
          onClick={newChat}
        />
      ) : null}
    </div>
  );
};
