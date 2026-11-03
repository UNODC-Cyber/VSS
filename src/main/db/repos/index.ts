import type { Db } from '../open';
import { ExportRepo } from './export';
import { MergeLogRepo } from './mergeLog';
import { MetaRepo } from './meta';
import { NegativePairRepo } from './negativePair';
import { PersonRepo } from './person';
import { RequestRepo } from './request';
import { ResponseRepo } from './response';
import { ReviewItemRepo } from './reviewItem';
import { SettingRepo } from './setting';
import { StoredFileRepo } from './storedFile';
import { TemplateRepo } from './template';
import { UnitRepo } from './unit';
import { UnitVettingRecordRepo, VettingRecordRepo } from './vettingRecord';

export * from './export';
export * from './mergeLog';
export * from './meta';
export * from './negativePair';
export * from './person';
export * from './request';
export * from './response';
export * from './reviewItem';
export * from './setting';
export * from './storedFile';
export * from './template';
export * from './unit';
export * from './vettingRecord';
export { newId } from './util';

export interface Repos {
  persons: PersonRepo;
  units: UnitRepo;
  files: StoredFileRepo;
  requests: RequestRepo;
  exports: ExportRepo;
  responses: ResponseRepo;
  vetting: VettingRecordRepo;
  unitVetting: UnitVettingRecordRepo;
  reviews: ReviewItemRepo;
  negativePairs: NegativePairRepo;
  mergeLog: MergeLogRepo;
  settings: SettingRepo;
  meta: MetaRepo;
  templates: TemplateRepo;
}

export function createRepos(db: Db): Repos {
  return {
    persons: new PersonRepo(db),
    units: new UnitRepo(db),
    files: new StoredFileRepo(db),
    requests: new RequestRepo(db),
    exports: new ExportRepo(db),
    responses: new ResponseRepo(db),
    vetting: new VettingRecordRepo(db),
    unitVetting: new UnitVettingRecordRepo(db),
    reviews: new ReviewItemRepo(db),
    negativePairs: new NegativePairRepo(db),
    mergeLog: new MergeLogRepo(db),
    settings: new SettingRepo(db),
    meta: new MetaRepo(db),
    templates: new TemplateRepo(db),
  };
}
