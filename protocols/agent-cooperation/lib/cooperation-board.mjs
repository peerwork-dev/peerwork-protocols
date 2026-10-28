// SPDX-License-Identifier: Apache-2.0
import {literal, body, actor, time, ref, payload, eq, not, permission, schema, exact, append, action} from './dsl.mjs';

/** Shared knowledge and non-exclusive work announcements. No global task scheduler. */
export function cooperationBoard({readableDetails = false, maxAnnouncementMs = 3600000} = {}) {
  if (typeof readableDetails !== 'boolean' || !Number.isSafeInteger(maxAnnouncementMs) || maxAnnouncementMs < 1000 || maxAnnouncementMs > 86400000) throw Error('INVALID_COOPERATION_OPTIONS');
  const write = permission('WORKER', 'FINDING');
  const kinds = ['OBSERVED', 'FACT', 'FAIL', 'PATCH_SUMMARY'];
  const text = {subject: {type: 'string', maxBytes: 120}, summary: {type: 'string', maxBytes: 512}};
  const detailFields = readableDetails ? {detail: {type: 'string', maxBytes: 2048}} : {};
  const detail = readableDetails ? body('detail') : literal(null);
  const disclosure = literal(readableDetails ? 'READABLE_STRUCTURE' : 'E2EE_BODY');
  const finding = ref('previous', 'finding'), announcement = ref('previous', 'work.announcement');
  const alive = [eq(payload(announcement, 'status'), literal('ACTIVE')), {op: 'lt', left: time, right: payload(announcement, 'expires_at')}];
  const ownAnnouncement = [...write, eq(payload(announcement, 'author'), actor)];
  const ttl = {ttl_ms: {type: 'integer', minimum: 1000, maximum: maxAnnouncementMs}};
  const expires = {from: 'time_add', timestamp: time, milliseconds: body('ttl_ms')};
  const findingFields = {author: 'string', kind: 'string', subject: 'string', summary: 'string', detail_mode: 'string', detail: 'json', status: 'string', previous: 'json', created_at: 'integer'};
  const announcementFields = {kind: 'string', author: 'string', scope: 'string', summary: 'string', expires_at: 'integer', status: 'string', previous: 'json', created_at: 'integer'};
  const findingRecord = (status, previous = null) => append('finding', {
    author: actor, kind: previous ? payload(finding, 'kind') : body('kind'),
    subject: previous ? payload(finding, 'subject') : body('subject'),
    summary: previous ? payload(finding, 'summary') : body('summary'),
    detail_mode: previous ? payload(finding, 'detail_mode') : disclosure,
    detail: previous ? payload(finding, 'detail') : detail,
    status: literal(status), previous: previous ? finding : literal(null), created_at: time,
  }, previous ? {entity: {mode: 'revise', slot: 'finding', parent: finding}, relations: [{kind: 'supersedes', target: finding}]} : {entity: {mode: 'new', slot: 'finding'}});
  const reviseAnnouncement = (status, deadline) => append('work.announcement', {
    kind: literal('CLAIM'), author: actor, scope: payload(announcement, 'scope'), summary: payload(announcement, 'summary'),
    expires_at: deadline, status: literal(status), previous: announcement, created_at: time,
  }, {entity: {mode: 'revise', slot: 'announcement', parent: announcement}, relations: [{kind: 'supersedes', target: announcement}]});
  return {
    id: 'cooperation-board', initial_state: {}, roles: ['WORKER'], capabilities: ['FINDING'],
    schemas: {finding: schema(findingFields), 'finding.challenge': schema({author: 'string', target: 'json', summary: 'string', created_at: 'integer'}), 'work.announcement': schema(announcementFields)},
    actions: [
      action('finding.publish', {kind: {type: 'enum', values: kinds}, ...text, ...detailFields}, write, [findingRecord('ACTIVE')], {entities: ['finding']}),
      action('finding.correct', {previous: exact('finding'), ...text, ...detailFields}, [...write, eq(payload(finding, 'author'), actor), eq(payload(finding, 'status'), literal('ACTIVE'))], [append('finding', {
        author: actor, kind: payload(finding, 'kind'), subject: body('subject'), summary: body('summary'), detail_mode: disclosure, detail,
        status: literal('ACTIVE'), previous: finding, created_at: time,
      }, {entity: {mode: 'revise', slot: 'finding', parent: finding}, relations: [{kind: 'supersedes', target: finding}]})], {entities: ['finding']}),
      action('finding.retract', {previous: exact('finding')}, [...write, eq(payload(finding, 'author'), actor), eq(payload(finding, 'status'), literal('ACTIVE'))], [findingRecord('RETRACTED', finding)], {entities: ['finding']}),
      action('finding.challenge', {previous: exact('finding'), summary: text.summary}, [...write, not(eq(payload(finding, 'author'), actor))], [append('finding.challenge', {author: actor, target: finding, summary: body('summary'), created_at: time}, {relations: [{kind: 'challenges', target: finding}]})]),
      action('work.announce', {scope: {type: 'string', maxBytes: 256}, summary: text.summary, ...ttl}, write, [append('work.announcement', {
        kind: literal('CLAIM'), author: actor, scope: body('scope'), summary: body('summary'), expires_at: expires, status: literal('ACTIVE'), previous: literal(null), created_at: time,
      }, {entity: {mode: 'new', slot: 'announcement'}})], {entities: ['announcement']}),
      action('work.announcement.renew', {previous: exact('work.announcement'), ...ttl}, [...ownAnnouncement, ...alive, {op: 'gt', left: expires, right: payload(announcement, 'expires_at')}], [reviseAnnouncement('ACTIVE', expires)], {entities: ['announcement']}),
      action('work.announcement.release', {previous: exact('work.announcement')}, [...ownAnnouncement, eq(payload(announcement, 'status'), literal('ACTIVE'))], [reviseAnnouncement('RELEASED', payload(announcement, 'expires_at'))], {entities: ['announcement']}),
    ],
  };
}
