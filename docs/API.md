# Writer HTTP API (generated from the route table)

Every route is under `/api`, loopback only, requires the session cookie and (for writes) the `X-SLAI-Writer` header, and answers `{ok, data}` or `{ok:false, error:{code,message,hint,details}}`. Regenerate with `python3 docs/gen_api.py`.


## routes_account.py

| Method | Path | Handler |
|---|---|---|
| GET | `/api/account` | `account_me` |
| POST | `/api/account/signup` | `signup` |
| POST | `/api/account/signup/resend` | `signup_resend` |
| POST | `/api/account/signup/verify` | `signup_verify` |
| POST | `/api/account/signup/cancel` | `signup_cancel` |
| POST | `/api/account/login` | `login` |
| POST | `/api/account/login/code` | `login_code` |
| POST | `/api/account/login/recovery-code` | `login_recovery` |
| POST | `/api/account/logout` | `logout` |
| POST | `/api/account/2fa/begin` | `tfa_begin` |
| POST | `/api/account/2fa/confirm` | `tfa_confirm` |
| POST | `/api/account/2fa/disable` | `tfa_disable` |
| POST | `/api/account/recovery-codes` | `recovery_codes` |
| POST | `/api/account/password` | `change_password` |
| POST | `/api/account/reset` | `reset_request` |
| POST | `/api/account/reset/complete` | `reset_complete` |
| POST | `/api/account/mfa-recovery` | `mfa_recovery_start` |
| POST | `/api/account/mfa-recovery/confirm` | `mfa_recovery_confirm` |
| POST | `/api/account/mfa-recovery/cancel` | `mfa_recovery_cancel` |
| GET | `/api/account/sessions` | `sessions` |
| DELETE | `/api/account/sessions/{id}` | `revoke_session` |
| DELETE | `/api/account/devices/{id}` | `revoke_device` |
| GET | `/api/plans` | `plans` |
| POST | `/api/plans/checkout` | `plan_checkout` |

## routes_core.py

| Method | Path | Handler |
|---|---|---|
| GET | `/api/bootstrap` | `bootstrap` |
| GET | `/api/prefs` | `prefs_get` |
| PUT | `/api/prefs` | `prefs_put` |
| GET | `/api/home` | `home` |
| POST | `/api/library/folders` | `folder_add` |
| DELETE | `/api/library/folders/{id}` | `folder_remove` |
| GET | `/api/library/folders/{id}/documents` | `folder_documents` |
| POST | `/api/library/favorite` | `favorite` |
| POST | `/api/library/forget` | `forget` |
| POST | `/api/library/locate` | `locate` |
| GET | `/api/recovery` | `recovery_list` |
| POST | `/api/recovery/{id}/open` | `recovery_open` |
| DELETE | `/api/recovery/{id}` | `recovery_discard` |
| GET | `/api/fs/browse` | `browse` |
| POST | `/api/fs/pick` | `pick` |
| GET | `/api/templates` | `template_list` |
| GET | `/api/cursors` | `cursor_list` |
| POST | `/api/cursors` | `cursor_add` |
| GET | `/api/cursors/{id}.png` | `cursor_image` |
| DELETE | `/api/cursors/{id}` | `cursor_delete` |

## routes_docs.py

| Method | Path | Handler |
|---|---|---|
| POST | `/api/docs/new` | `doc_new` |
| POST | `/api/docs/open` | `doc_open` |
| GET | `/api/docs` | `doc_list` |
| GET | `/api/docs/{sid}` | `doc_state` |
| POST | `/api/docs/{sid}/close` | `doc_close` |
| POST | `/api/docs/{sid}/identity` | `doc_identity` |
| POST | `/api/docs/{sid}/ops` | `doc_ops` |
| POST | `/api/docs/{sid}/undo` | `doc_undo` |
| POST | `/api/docs/{sid}/redo` | `doc_redo` |
| GET | `/api/docs/{sid}/history-stack` | `doc_stack` |
| POST | `/api/docs/{sid}/save` | `doc_save` |
| POST | `/api/docs/{sid}/save-as` | `doc_save_as` |
| POST | `/api/docs/{sid}/rename` | `doc_rename` |
| POST | `/api/docs/{sid}/autosave` | `doc_autosave` |
| POST | `/api/docs/{sid}/external` | `doc_external` |
| GET | `/api/docs/{sid}/external` | `doc_external_status` |
| GET | `/api/docs/{sid}/versions` | `versions` |
| POST | `/api/docs/{sid}/versions` | `version_create` |
| POST | `/api/docs/{sid}/versions/{vid}/restore` | `version_restore` |
| POST | `/api/docs/{sid}/versions/{vid}/open` | `version_open` |
| POST | `/api/docs/{sid}/comments` | `comment_add` |
| POST | `/api/docs/{sid}/comments/{tid}/reply` | `comment_reply` |
| POST | `/api/docs/{sid}/comments/{tid}/status` | `comment_status` |
| GET | `/api/docs/{sid}/notes` | `notes` |
| POST | `/api/docs/{sid}/notes` | `note_put` |
| DELETE | `/api/docs/{sid}/notes/{nid}` | `note_delete` |
| POST | `/api/docs/{sid}/images` | `image_add` |
| GET | `/api/docs/{sid}/assets/{aid}` | `asset_get` |
| GET | `/api/docs/{sid}/search` | `doc_search` |
| POST | `/api/docs/{sid}/replace` | `doc_replace` |
| GET | `/api/docs/{sid}/outline` | `doc_outline` |

## routes_tools.py

| Method | Path | Handler |
|---|---|---|
| GET | `/api/signing/key` | `sign_key` |
| POST | `/api/signing/key` | `sign_key_create` |
| POST | `/api/signing/key/delete` | `sign_key_delete` |
| GET | `/api/docs/{sid}/sign` | `sign_preview` |
| POST | `/api/docs/{sid}/sign` | `sign_do` |
| GET | `/api/docs/{sid}/verify` | `verify` |
| GET | `/api/docs/{sid}/compare/{snapshot}` | `compare` |
| POST | `/api/docs/{sid}/trust` | `trust` |
| POST | `/api/signing/revoke` | `revoke` |
| GET | `/api/signing/marks` | `marks` |
| POST | `/api/signing/marks` | `mark_add` |
| DELETE | `/api/signing/marks/{id}` | `mark_delete` |
| POST | `/api/docs/{sid}/signature-graphic` | `mark_place` |
| GET | `/api/embeds/catalogue` | `embed_catalogue` |
| GET | `/api/docs/{sid}/embeds` | `embeds_list` |
| GET | `/api/docs/{sid}/embeds/{eid}` | `embed_view` |
| POST | `/api/docs/{sid}/embeds/validate` | `embed_validate` |
| POST | `/api/docs/{sid}/embeds/preview` | `embed_preview` |
| POST | `/api/docs/{sid}/embeds/apply` | `embed_apply` |
| POST | `/api/docs/{sid}/embeds/{eid}/lock` | `embed_lock` |
| DELETE | `/api/docs/{sid}/embeds/{eid}/lock` | `embed_unlock` |
| POST | `/api/docs/{sid}/embeds/{eid}/request-access` | `embed_request` |
| GET | `/api/assist/status` | `assist_status` |
| POST | `/api/docs/{sid}/spell` | `spell` |
| POST | `/api/docs/{sid}/dictionary` | `dictionary` |
| POST | `/api/docs/{sid}/grammar` | `grammar` |
| POST | `/api/docs/{sid}/assist` | `assist_propose` |
| GET | `/api/assist/jobs/{id}` | `assist_job` |
| POST | `/api/assist/jobs/{id}/cancel` | `assist_cancel` |
| POST | `/api/docs/{sid}/assist/apply` | `assist_apply` |
| POST | `/api/assist/proposals/{id}/reject` | `assist_reject` |
| GET | `/api/docs/{sid}/sources` | `sources` |
| POST | `/api/docs/{sid}/sources` | `source_put` |
| DELETE | `/api/docs/{sid}/sources/{id}` | `source_delete` |
| POST | `/api/docs/{sid}/sources/{id}/checked` | `source_checked` |
| POST | `/api/docs/{sid}/sources/{id}/verify-doi` | `source_verify` |
| POST | `/api/docs/{sid}/cite` | `cite` |
| POST | `/api/docs/{sid}/footnote` | `footnote` |
| POST | `/api/docs/{sid}/bibliography` | `bibliography` |
| POST | `/api/docs/{sid}/contents` | `contents` |
| POST | `/api/docs/{sid}/xref` | `xref` |
| GET | `/api/exchange/formats` | `formats` |
| GET | `/api/docs/{sid}/preflight` | `preflight` |
| POST | `/api/docs/{sid}/export` | `export` |
| POST | `/api/docs/{sid}/download` | `download` |
| POST | `/api/docs/{sid}/preview` | `preview` |
| POST | `/api/import` | `import_upload` |
| POST | `/api/import/path` | `import_path` |
| GET | `/api/workspace` | `workspace` |
| POST | `/api/docs/{sid}/workspace/{action}` | `workspace_action` |
| POST | `/api/docs/{sid}/merge-copy` | `merge_copy` |
