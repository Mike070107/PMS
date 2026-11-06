import type {ReactNode} from 'react';
import { App as AntdApp, ConfigProvider, Result } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import {useUiPreferences} from '@/components/UiPreferencesProvider';
import {useSession} from '@/lib/auth';
import {pagePerm} from '@/legacy/lib/auth';
import '@/styles/migrated-surface.css';
export default function MigratedSurface({pageKey,children}:{pageKey:string;children:ReactNode}){const s=useSession();const {palette}=useUiPreferences();const {canView}=pagePerm(s.access,pageKey);if(!canView)return <Result status="403" title="没有此页面的查看权限" subTitle="请联系管理员核对现有权限；迁移不会自动授予权限。"/>;return <ConfigProvider locale={zhCN} theme={{token:{colorPrimary:palette.primary,fontSize:16,controlHeight:44,borderRadius:8}}}><AntdApp><section className="migrated-surface" key={JSON.stringify([s.user?.id,s.actingTenant,s.actingOffice])}>{children}</section></AntdApp></ConfigProvider>}
