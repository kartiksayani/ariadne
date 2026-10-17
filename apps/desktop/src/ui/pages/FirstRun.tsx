// First run (SPEC 5.15, "No projects yet"): what Ariadne is, three steps to connect a first session, and a quiet line
// that it is waiting. Pure props in, callbacks out (contract C8).
import { copyIcon, copyLabel, useCopy } from '../parts/parts';
import type { FirstRunProps } from './page-types';
import './first-run.css';

export function FirstRun({ command, onCopyCommand, onCopyInstruction, onRegister }: FirstRunProps) {
  const [copied, copyCommand] = useCopy(), [instruction, copyInstruction] = useCopy();
  return <div className="fr" role="region" aria-label="No projects yet">
    <div className="fr-col">
      <h1 className="fr-title">No projects yet</h1>
      <p className="fr-lead">Ariadne follows a conversation with a coding agent and lays out its questions, decisions and findings as a Map. A project shows up here when a session in its folder connects.</p>
      <ol className="fr-steps">
        <li className="fr-step">
          <span className="fr-num" aria-hidden="true">1</span>
          <div className="fr-body"><span>Start Claude Code or Codex in your project’s folder.</span></div>
        </li>
        <li className="fr-step">
          <span className="fr-num" aria-hidden="true">2</span>
          <div className="fr-body">
            <span>In the Claude Code conversation, run:</span>
            <span className="fr-line">
              <code className="fr-code">{command}</code>
              <button type="button" className="p-btn p-btn-copy" onClick={() => { copyCommand(onCopyCommand); }}><i className={copyIcon(copied)} aria-hidden="true" />{copyLabel(copied, 'Copy')}</button>
            </span>
            {onCopyInstruction
              ? <span className="fr-alt">Using Codex? Paste the setup instruction into its thread once.
                <button type="button" className="p-btn p-btn-copy" onClick={() => { copyInstruction(onCopyInstruction); }}><i className={copyIcon(instruction)} aria-hidden="true" />{copyLabel(instruction, 'Copy instruction')}</button>
              </span>
              : <span className="fr-alt">Using Codex? Register your project’s folder first; Ariadne then gives you a setup instruction to paste into its thread once.
                <button type="button" className="p-btn p-btn-copy" onClick={onRegister}><i className="ph ph-plus" aria-hidden="true" />Register a project</button>
              </span>}
          </div>
        </li>
        <li className="fr-step">
          <span className="fr-num" aria-hidden="true">3</span>
          <div className="fr-body"><span>The project and its session open here, and the Map fills in as the agent works.</span></div>
        </li>
      </ol>
      <div className="fr-wait" role="status"><span className="fr-ring" aria-hidden="true" />Waiting for a session to connect. Connecting sends nothing to the model.</div>
    </div>
  </div>;
}
