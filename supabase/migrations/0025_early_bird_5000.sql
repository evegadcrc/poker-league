-- Llegada temprana (early-bird chip bonus): default 2000 → 5000, and bump the
-- current active season so live/upcoming fechas use it.
alter table public.season alter column early_bird_bonus_chips set default 5000;

update public.season
   set early_bird_bonus_chips = 5000
 where status = 'active';
