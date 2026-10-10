import type { ReactNode } from 'react';
import { Header, type HeaderProps } from './Header';
import { TabBar, type TabBarProps } from './TabBar';
import { Body, type BodyProps } from './Body';
import { Footer } from './Footer';
import { Notices } from '../pages/notices';
import './shell.css';

export interface ShellProps {
  readonly header: HeaderProps;
  readonly tabs: TabBarProps;
  readonly body: BodyProps;
  readonly summary: string;
  readonly overlay?: ReactNode;
}

/** The Paperwhite chrome: 48px header, 38px tab bar, body grid, 30px footer. */
export function Shell({ header, tabs, body, summary, overlay }: ShellProps) {
  return <div className="shell">
    <Header {...header} />
    <TabBar {...tabs} />
    <Body {...body} />
    <Footer summary={summary} />
    <Notices />
    {overlay}
  </div>;
}
