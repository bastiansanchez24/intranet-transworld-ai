-- Refactor public schema identifiers from Spanish to English.
-- Table/column renames preserve data; status literals are migrated where applicable.

BEGIN;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
ALTER TABLE users RENAME COLUMN area_trabajo_id TO work_area_id;
ALTER TABLE users RENAME COLUMN fecha_nacimiento TO birth_date;
ALTER TABLE users RENAME COLUMN usuario_intranet TO is_intranet_user;
ALTER TABLE users RENAME COLUMN telefono TO phone;
ALTER TABLE users RENAME COLUMN foto TO photo;

-- ---------------------------------------------------------------------------
-- work_areas (was area_trabajo)
-- ---------------------------------------------------------------------------
ALTER TABLE area_trabajo RENAME COLUMN nombre_area TO area_name;
ALTER TABLE area_trabajo RENAME TO work_areas;
ALTER SEQUENCE area_trabajo_id_seq RENAME TO work_areas_id_seq;
ALTER INDEX area_trabajo_pkey RENAME TO work_areas_pkey;
ALTER INDEX area_trabajo_nombre_area_key RENAME TO work_areas_area_name_key;

-- ---------------------------------------------------------------------------
-- question_options (was alternativas)
-- ---------------------------------------------------------------------------
ALTER TABLE alternativas RENAME COLUMN pregunta_id TO question_id;
ALTER TABLE alternativas RENAME COLUMN texto TO text;
ALTER TABLE alternativas RENAME COLUMN es_correcta TO is_correct;
ALTER TABLE alternativas RENAME TO question_options;
ALTER SEQUENCE alternativas_id_seq RENAME TO question_options_id_seq;
ALTER INDEX alternativas_pkey RENAME TO question_options_pkey;

-- ---------------------------------------------------------------------------
-- applications (was aplicaciones)
-- ---------------------------------------------------------------------------
ALTER TABLE aplicaciones RENAME COLUMN nombre TO name;
ALTER TABLE aplicaciones RENAME COLUMN descripcion TO description;
ALTER TABLE aplicaciones RENAME COLUMN fecha_creacion TO created_at;
ALTER TABLE aplicaciones RENAME COLUMN ultima_actualizacion TO updated_at;
ALTER TABLE aplicaciones RENAME COLUMN cambios TO changelog;
ALTER TABLE aplicaciones RENAME COLUMN notificado TO notified;
ALTER TABLE aplicaciones RENAME TO applications;
ALTER SEQUENCE aplicaciones_id_seq RENAME TO applications_id_seq;
ALTER INDEX aplicaciones_pkey RENAME TO applications_pkey;

-- ---------------------------------------------------------------------------
-- courses (was cursos)
-- ---------------------------------------------------------------------------
ALTER TABLE cursos RENAME COLUMN titulo TO title;
ALTER TABLE cursos RENAME COLUMN descripcion TO description;
ALTER TABLE cursos RENAME COLUMN tiempo_requerido_segundos TO required_watch_seconds;
ALTER TABLE cursos RENAME COLUMN activo TO is_active;
ALTER TABLE cursos RENAME COLUMN consejos_comerciales TO commercial_tips;
ALTER TABLE cursos RENAME COLUMN seccion TO section;
ALTER TABLE cursos RENAME COLUMN subseccion TO subsection;
ALTER TABLE cursos RENAME TO courses;
ALTER SEQUENCE cursos_id_seq RENAME TO courses_id_seq;
ALTER INDEX cursos_pkey RENAME TO courses_pkey;

-- ---------------------------------------------------------------------------
-- user_course_progress (was capacitaciones_usuarios)
-- ---------------------------------------------------------------------------
ALTER TABLE capacitaciones_usuarios RENAME COLUMN usuario_id TO user_id;
ALTER TABLE capacitaciones_usuarios RENAME COLUMN curso_id TO course_id;
ALTER TABLE capacitaciones_usuarios RENAME COLUMN segundos_vistos TO seconds_watched;
ALTER TABLE capacitaciones_usuarios RENAME COLUMN estado TO status;
ALTER TABLE capacitaciones_usuarios RENAME COLUMN nota TO score;
ALTER TABLE capacitaciones_usuarios RENAME COLUMN fecha_inicio TO started_at;
ALTER TABLE capacitaciones_usuarios RENAME COLUMN fecha_completado TO completed_at;
ALTER TABLE capacitaciones_usuarios RENAME COLUMN intentos TO attempts;
ALTER TABLE capacitaciones_usuarios RENAME TO user_course_progress;
ALTER SEQUENCE capacitaciones_usuarios_id_seq RENAME TO user_course_progress_id_seq;
ALTER INDEX capacitaciones_usuarios_pkey RENAME TO user_course_progress_pkey;
ALTER INDEX capacitaciones_usuarios_usuario_id_curso_id_key RENAME TO user_course_progress_user_id_course_id_key;

UPDATE user_course_progress SET status = 'in_progress' WHERE status IN ('en_progreso', 'En curso');
UPDATE user_course_progress SET status = 'evaluated' WHERE status = 'Evaluado';

-- ---------------------------------------------------------------------------
-- documents (was documentos)
-- ---------------------------------------------------------------------------
ALTER TABLE documentos RENAME COLUMN nombre TO name;
ALTER TABLE documentos RENAME COLUMN tipo TO type;
ALTER TABLE documentos RENAME COLUMN usuario_id TO user_id;
ALTER TABLE documentos RENAME COLUMN fecha_creacion TO created_at;
ALTER TABLE documentos RENAME TO documents;
ALTER SEQUENCE documentos_id_seq RENAME TO documents_id_seq;
ALTER INDEX documentos_pkey RENAME TO documents_pkey;

-- ---------------------------------------------------------------------------
-- events (was eventos)
-- ---------------------------------------------------------------------------
ALTER TABLE eventos RENAME COLUMN nombre TO name;
ALTER TABLE eventos RENAME COLUMN descripcion TO description;
ALTER TABLE eventos RENAME COLUMN imagen TO image;
ALTER TABLE eventos RENAME COLUMN fecha_creacion TO created_at;
ALTER TABLE eventos RENAME TO events;
ALTER SEQUENCE eventos_id_seq RENAME TO events_id_seq;
ALTER INDEX eventos_pkey RENAME TO events_pkey;
ALTER INDEX eventos_slug_key RENAME TO events_slug_key;

-- ---------------------------------------------------------------------------
-- event_photos (was eventos_fotos)
-- ---------------------------------------------------------------------------
ALTER TABLE eventos_fotos RENAME COLUMN evento_id TO event_id;
ALTER TABLE eventos_fotos RENAME TO event_photos;
ALTER SEQUENCE eventos_fotos_id_seq RENAME TO event_photos_id_seq;
ALTER INDEX eventos_fotos_pkey RENAME TO event_photos_pkey;

-- ---------------------------------------------------------------------------
-- change_log (was historial_cambios)
-- ---------------------------------------------------------------------------
ALTER TABLE historial_cambios RENAME COLUMN usuario_id TO user_id;
ALTER TABLE historial_cambios RENAME COLUMN accion TO action;
ALTER TABLE historial_cambios RENAME COLUMN seccion TO section;
ALTER TABLE historial_cambios RENAME COLUMN enlace TO link_path;
ALTER TABLE historial_cambios RENAME COLUMN fecha TO created_at;
ALTER TABLE historial_cambios RENAME TO change_log;
ALTER SEQUENCE historial_cambios_id_seq RENAME TO change_log_id_seq;
ALTER INDEX historial_cambios_pkey RENAME TO change_log_pkey;

-- ---------------------------------------------------------------------------
-- linkedin_posts
-- ---------------------------------------------------------------------------
ALTER TABLE linkedin_posts RENAME COLUMN imagen_url TO image_url;
ALTER TABLE linkedin_posts RENAME COLUMN enlace_url TO link_url;
ALTER TABLE linkedin_posts RENAME COLUMN fecha_creacion TO created_at;

-- ---------------------------------------------------------------------------
-- study_materials (was material_estudio)
-- ---------------------------------------------------------------------------
ALTER TABLE material_estudio RENAME COLUMN seccion TO section;
ALTER TABLE material_estudio RENAME COLUMN nombre TO name;
ALTER TABLE material_estudio RENAME COLUMN archivo_url TO file_url;
ALTER TABLE material_estudio RENAME COLUMN tipo_recurso TO resource_type;
ALTER TABLE material_estudio RENAME COLUMN fecha_creacion TO created_at;
ALTER TABLE material_estudio RENAME TO study_materials;
ALTER SEQUENCE material_estudio_id_seq RENAME TO study_materials_id_seq;
ALTER INDEX material_estudio_pkey RENAME TO study_materials_pkey;

-- ---------------------------------------------------------------------------
-- news_articles (was noticias)
-- ---------------------------------------------------------------------------
ALTER TABLE noticias RENAME COLUMN titulo TO title;
ALTER TABLE noticias RENAME COLUMN subtitulo TO subtitle;
ALTER TABLE noticias RENAME COLUMN contenido TO content;
ALTER TABLE noticias RENAME COLUMN imagen TO image;
ALTER TABLE noticias RENAME COLUMN adjuntos TO attachments;
ALTER TABLE noticias RENAME COLUMN fecha_creacion TO created_at;
ALTER TABLE noticias RENAME COLUMN autor TO author;
ALTER TABLE noticias RENAME COLUMN destacada TO featured;
ALTER TABLE noticias RENAME TO news_articles;
ALTER SEQUENCE noticias_id_seq RENAME TO news_articles_id_seq;
ALTER INDEX noticias_pkey RENAME TO news_articles_pkey;
ALTER INDEX idx_noticias_destacada RENAME TO idx_news_articles_featured;

-- ---------------------------------------------------------------------------
-- other_documents (was otros_docs)
-- ---------------------------------------------------------------------------
ALTER TABLE otros_docs RENAME COLUMN nombre TO name;
ALTER TABLE otros_docs RENAME COLUMN fecha_creacion TO created_at;
ALTER TABLE otros_docs RENAME TO other_documents;
ALTER SEQUENCE otros_docs_id_seq RENAME TO other_documents_id_seq;
ALTER INDEX otros_docs_pkey RENAME TO other_documents_pkey;

-- ---------------------------------------------------------------------------
-- lunch_menu (was platos)
-- ---------------------------------------------------------------------------
ALTER TABLE platos RENAME COLUMN dia_numero TO day_number;
ALTER TABLE platos RENAME COLUMN nombre_plato TO dish_name;
ALTER TABLE platos RENAME TO lunch_menu;
ALTER SEQUENCE platos_id_seq RENAME TO lunch_menu_id_seq;
ALTER INDEX platos_pkey RENAME TO lunch_menu_pkey;
ALTER INDEX platos_dia_numero_key RENAME TO lunch_menu_day_number_key;

-- ---------------------------------------------------------------------------
-- questions (was preguntas)
-- ---------------------------------------------------------------------------
ALTER TABLE preguntas RENAME COLUMN curso_id TO course_id;
ALTER TABLE preguntas RENAME COLUMN enunciado TO question_text;
ALTER TABLE preguntas RENAME COLUMN orden TO sort_order;
ALTER TABLE preguntas RENAME TO questions;
ALTER SEQUENCE preguntas_id_seq RENAME TO questions_id_seq;
ALTER INDEX preguntas_pkey RENAME TO questions_pkey;

-- ---------------------------------------------------------------------------
-- subsection_details (was subsecciones_detalles)
-- ---------------------------------------------------------------------------
ALTER TABLE subsecciones_detalles RENAME COLUMN nombre TO name;
ALTER TABLE subsecciones_detalles RENAME COLUMN imagen_url TO image_url;
ALTER TABLE subsecciones_detalles RENAME TO subsection_details;
ALTER INDEX subsecciones_detalles_pkey RENAME TO subsection_details_pkey;

-- ---------------------------------------------------------------------------
-- support_tickets (was tickets) + ticket_replies (was ticket_respuestas)
-- ---------------------------------------------------------------------------
ALTER TABLE tickets RENAME COLUMN titulo TO title;
ALTER TABLE tickets RENAME COLUMN descripcion TO description;
ALTER TABLE tickets RENAME COLUMN categoria TO category;
ALTER TABLE tickets RENAME COLUMN prioridad TO priority;
ALTER TABLE tickets RENAME COLUMN estado TO status;
ALTER TABLE tickets RENAME COLUMN solicitante_nombre TO requester_name;
ALTER TABLE tickets RENAME COLUMN solicitante_email TO requester_email;
ALTER TABLE tickets RENAME COLUMN fecha_creacion TO created_at;
ALTER TABLE tickets RENAME COLUMN fecha_resolucion TO resolved_at;
ALTER TABLE tickets RENAME COLUMN fecha_cierre TO closed_at;
ALTER TABLE tickets RENAME COLUMN cierre_automatico TO auto_closed;
ALTER TABLE tickets RENAME COLUMN adjuntos TO attachments;
ALTER TABLE tickets RENAME COLUMN leido_usuario TO read_by_user;
ALTER TABLE tickets RENAME COLUMN leido_admin TO read_by_admin;
ALTER TABLE tickets RENAME COLUMN asignado_a TO assigned_to;
ALTER TABLE tickets RENAME TO support_tickets;
ALTER SEQUENCE tickets_id_seq RENAME TO support_tickets_id_seq;
ALTER INDEX tickets_pkey RENAME TO support_tickets_pkey;

ALTER TABLE ticket_respuestas RENAME COLUMN mensaje TO message;
ALTER TABLE ticket_respuestas RENAME COLUMN remitente TO sender;
ALTER TABLE ticket_respuestas RENAME COLUMN archivo_url TO file_url;
ALTER TABLE ticket_respuestas RENAME COLUMN archivo_nombre TO file_name;
ALTER TABLE ticket_respuestas RENAME COLUMN archivo_tipo TO file_type;
ALTER TABLE ticket_respuestas RENAME COLUMN adjuntos TO attachments;
ALTER TABLE ticket_respuestas RENAME COLUMN fecha TO created_at;
ALTER TABLE ticket_respuestas RENAME TO ticket_replies;
ALTER SEQUENCE ticket_respuestas_id_seq RENAME TO ticket_replies_id_seq;
ALTER INDEX ticket_respuestas_pkey RENAME TO ticket_replies_pkey;

UPDATE support_tickets SET status = 'open' WHERE status = 'Abierto';
UPDATE support_tickets SET status = 'in_progress' WHERE status = 'En curso';
UPDATE support_tickets SET status = 'pending_close' WHERE status = 'Pendiente de cierre';
UPDATE support_tickets SET status = 'closed' WHERE status = 'Cerrado';

UPDATE support_tickets SET priority = 'low' WHERE priority = 'Baja';
UPDATE support_tickets SET priority = 'medium' WHERE priority = 'Media';
UPDATE support_tickets SET priority = 'high' WHERE priority = 'Alta';

UPDATE ticket_replies SET sender = 'Support' WHERE sender = 'Soporte';
UPDATE ticket_replies SET sender = 'System' WHERE sender = 'Sistema';

COMMIT;
