import type { ReactNode } from 'react';
import { Header, type HeaderProps } from './Header';
import { TabBar, type TabBarProps } from './TabBar';
import { Body, type BodyProps } from './Body';
import { Footer } from './Footer';
import type { ConversationFooterState } from './model';
import './shell.css';

export interface ShellProps {
  readonly header: HeaderProps;
  readonly tabs: TabBarProps;
  readonly body: BodyProps;
  readonly summary: string;
  readonly conversationFooter?: ConversationFooterState;
  readonly overlay?: ReactNode;
}

/** The Paperwhite chrome: 48px header, 38px tab bar, body grid, 30px footer. */
export function Shell({ header, tabs, body, summary, conversationFooter, overlay }: ShellProps) {
  return <div className="shell">
    <Header {...header} />
    <TabBar {...tabs} />
    <Body {...body} />
    <Footer summary={summary} conversation={body.conversation ? conversationFooter ?? { question: false } : undefined} />
    {overlay}
  </div>;
}
