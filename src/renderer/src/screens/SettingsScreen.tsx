/**
 * Settings: layout only. Every card lives in components/settings/*.tsx (one owner per card, see
 * docs/PLAN-ALPHA.md section 3). Draft cards edit one unsaved Settings object that SaveCard stores through the
 * password-gated settings.update.
 */
import { Stack } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '@shared/domain/types';
import { BackupCard } from '../components/BackupCard';
import { PageHeader } from '../components/common';
import { AboutCard } from '../components/settings/AboutCard';
import { AppearanceCard } from '../components/settings/AppearanceCard';
import { DangerZoneCard } from '../components/settings/DangerZoneCard';
import { EmailTemplatesCard } from '../components/settings/EmailTemplatesCard';
import { ExportPolicyCard } from '../components/settings/ExportPolicyCard';
import { GeneralCard } from '../components/settings/GeneralCard';
import { PasswordCard } from '../components/settings/PasswordCard';
import { PeerCard } from '../components/settings/PeerCard';
import { SaveCard } from '../components/settings/SaveCard';
import { UpdatesCard } from '../components/settings/UpdatesCard';
import { VettingAuthorityCard } from '../components/settings/VettingAuthorityCard';
import { TemplatesCard } from '../components/TemplatesCard';
import { useCardAnchor } from '../components/useCardAnchor';
import { useAction, vss } from '../lib/api';
import { useUi } from '../store';

export function SettingsScreen() {
  const { t } = useTranslation();
  const act = useAction();
  const current = useUi((s) => s.settings);
  const setSettings = useUi((s) => s.setSettings);
  const [s, setS] = useState<Settings>(structuredClone(current));
  const [pw, setPw] = useState('');
  useCardAnchor();
  const dirty = JSON.stringify(s) !== JSON.stringify(current);

  const save = async () => {
    const r = await act(vss().settings.update({ settings: s, reauth: { password: pw } }), t('settings.saved'));
    setPw('');
    if (!r) return;
    setSettings(r);
    setS(structuredClone(r));
    if (r.peerModeEnabled !== current.peerModeEnabled) await vss().peer.setEnabled({ enabled: r.peerModeEnabled });
  };

  return (
    <Stack maw={720}>
      <PageHeader title={t('settings.title')} />
      <GeneralCard value={s} onChange={setS} />
      <ExportPolicyCard value={s} onChange={setS} />
      <div id="card-email-templates">
        <EmailTemplatesCard value={s} onChange={setS} />
      </div>
      <div id="card-authority">
        <VettingAuthorityCard value={s} onChange={setS} />
      </div>
      <div id="card-appearance">
        <AppearanceCard value={s} onChange={setS} />
      </div>
      <PeerCard value={s} onChange={setS} />
      <SaveCard
        password={pw}
        onPasswordChange={setPw}
        dirty={dirty}
        onSave={() => void save()}
        onRevert={() => setS(structuredClone(current))}
      />
      <div id="card-templates">
        <TemplatesCard />
      </div>
      <div id="card-password">
        <PasswordCard />
      </div>
      <div id="card-backup">
        <BackupCard />
      </div>
      <div id="card-updates">
        <UpdatesCard />
      </div>
      <AboutCard />
      <DangerZoneCard />
    </Stack>
  );
}
