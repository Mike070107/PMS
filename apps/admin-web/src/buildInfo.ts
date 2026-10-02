/**
 * 管理后台构建信息。
 * Vite 在每次构建时注入版本和日期；开发服务器没有注入值时明确显示 dev，
 * 避免把本地预览误认为生产版本。
 */
const env = import.meta.env;

export const APP_VERSION = env.VITE_APP_VERSION || 'dev';
export const BUILD_DATE = env.VITE_BUILD_DATE || '';
export const BUILD_COMMIT = env.VITE_BUILD_COMMIT || '';

export const BUILD_LABEL =
  APP_VERSION === 'dev'
    ? '开发版'
    : `版本 ${APP_VERSION}`;
