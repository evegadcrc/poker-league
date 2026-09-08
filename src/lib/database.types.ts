export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      blind_level: {
        Row: {
          ante: number | null
          big_blind: number
          duration_seconds: number
          id: string
          is_break: boolean
          level_number: number
          small_blind: number
          structure_id: string
        }
        Insert: {
          ante?: number | null
          big_blind: number
          duration_seconds: number
          id?: string
          is_break?: boolean
          level_number: number
          small_blind: number
          structure_id: string
        }
        Update: {
          ante?: number | null
          big_blind?: number
          duration_seconds?: number
          id?: string
          is_break?: boolean
          level_number?: number
          small_blind?: number
          structure_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blind_level_structure_id_fkey"
            columns: ["structure_id"]
            isOneToOne: false
            referencedRelation: "blind_structure"
            referencedColumns: ["id"]
          },
        ]
      }
      blind_structure: {
        Row: {
          created_at: string
          id: string
          name: string
          season_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          season_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          season_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blind_structure_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "season"
            referencedColumns: ["id"]
          },
        ]
      }
      entry: {
        Row: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }
        Insert: {
          cancelled_at?: string | null
          check_in_geo_ok?: boolean | null
          checked_in_at?: string | null
          chips?: number | null
          chop_group?: number | null
          chopped?: boolean
          created_at?: string
          early_bird?: boolean
          eliminated_at?: string | null
          final_position?: number | null
          id?: string
          made_final_table?: boolean
          paid?: boolean
          player_id: string
          points_earned?: number | null
          rebuys_count?: number
          rsvp_at?: string | null
          status?: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }
        Update: {
          cancelled_at?: string | null
          check_in_geo_ok?: boolean | null
          checked_in_at?: string | null
          chips?: number | null
          chop_group?: number | null
          chopped?: boolean
          created_at?: string
          early_bird?: boolean
          eliminated_at?: string | null
          final_position?: number | null
          id?: string
          made_final_table?: boolean
          paid?: boolean
          player_id?: string
          points_earned?: number | null
          rebuys_count?: number
          rsvp_at?: string | null
          status?: Database["public"]["Enums"]["entry_status"]
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entry_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "player"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entry_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournament"
            referencedColumns: ["id"]
          },
        ]
      }
      gallery_photo: {
        Row: {
          created_at: string
          id: string
          storage_path: string
          tournament_id: string
          uploader_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          storage_path: string
          tournament_id: string
          uploader_id: string
        }
        Update: {
          created_at?: string
          id?: string
          storage_path?: string
          tournament_id?: string
          uploader_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gallery_photo_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournament"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gallery_photo_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "player"
            referencedColumns: ["id"]
          },
        ]
      }
      player: {
        Row: {
          auth_user_id: string | null
          avatar_url: string | null
          blocked: boolean
          created_at: string
          email: string
          id: string
          is_admin: boolean
          is_guest: boolean
          name: string
        }
        Insert: {
          auth_user_id?: string | null
          avatar_url?: string | null
          blocked?: boolean
          created_at?: string
          email: string
          id?: string
          is_admin?: boolean
          is_guest?: boolean
          name: string
        }
        Update: {
          auth_user_id?: string | null
          avatar_url?: string | null
          blocked?: boolean
          created_at?: string
          email?: string
          id?: string
          is_admin?: boolean
          is_guest?: boolean
          name?: string
        }
        Relationships: []
      }
      push_subscription: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          player_id: string
          user_agent: string | null
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          player_id: string
          user_agent?: string | null
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          player_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscription_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "player"
            referencedColumns: ["id"]
          },
        ]
      }
      season: {
        Row: {
          auto_approve_signups: boolean
          bonus_attendance: number
          bonus_final_table: number
          bonus_top3: number
          cancel_bands: Json
          created_at: string
          early_bird_bonus_chips: number
          final_table_size_override: number | null
          id: string
          name: string
          no_show_penalty: number
          payout_template: Json
          points_multiplier: number
          status: Database["public"]["Enums"]["season_status"]
          top_finish_bonuses: Json
          year: number
        }
        Insert: {
          auto_approve_signups?: boolean
          bonus_attendance?: number
          bonus_final_table?: number
          bonus_top3?: number
          cancel_bands?: Json
          created_at?: string
          early_bird_bonus_chips?: number
          final_table_size_override?: number | null
          id?: string
          name: string
          no_show_penalty?: number
          payout_template?: Json
          points_multiplier?: number
          status?: Database["public"]["Enums"]["season_status"]
          top_finish_bonuses?: Json
          year: number
        }
        Update: {
          auto_approve_signups?: boolean
          bonus_attendance?: number
          bonus_final_table?: number
          bonus_top3?: number
          cancel_bands?: Json
          created_at?: string
          early_bird_bonus_chips?: number
          final_table_size_override?: number | null
          id?: string
          name?: string
          no_show_penalty?: number
          payout_template?: Json
          points_multiplier?: number
          status?: Database["public"]["Enums"]["season_status"]
          top_finish_bonuses?: Json
          year?: number
        }
        Relationships: []
      }
      signup_request: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          email: string
          id: string
          name: string | null
          status: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email: string
          id?: string
          name?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email?: string
          id?: string
          name?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "signup_request_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "player"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament: {
        Row: {
          ante_enabled: boolean
          blind_structure_id: string | null
          buy_in: number
          cancelled_at: string | null
          counts_for_league: boolean
          cover_url: string | null
          created_at: string
          created_by: string | null
          current_level: number
          final_table_size: number | null
          geofence_radius_m: number
          id: string
          is_paused: boolean
          level_started_at: string | null
          name: string
          odds_enabled: boolean
          paused_remaining_seconds: number | null
          payout_distribution: Json | null
          prize_pool_override: number | null
          prizes: Json | null
          rebuy_amount: number | null
          rebuy_until_level: number | null
          scheduled_at: string
          season_id: string
          starting_stack: number | null
          status: Database["public"]["Enums"]["tournament_status"]
          timer_mode: Database["public"]["Enums"]["timer_mode"]
          venue_lat: number | null
          venue_lng: number | null
        }
        Insert: {
          ante_enabled?: boolean
          blind_structure_id?: string | null
          buy_in?: number
          cancelled_at?: string | null
          counts_for_league?: boolean
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          current_level?: number
          final_table_size?: number | null
          geofence_radius_m?: number
          id?: string
          is_paused?: boolean
          level_started_at?: string | null
          name: string
          odds_enabled?: boolean
          paused_remaining_seconds?: number | null
          payout_distribution?: Json | null
          prize_pool_override?: number | null
          prizes?: Json | null
          rebuy_amount?: number | null
          rebuy_until_level?: number | null
          scheduled_at: string
          season_id: string
          starting_stack?: number | null
          status?: Database["public"]["Enums"]["tournament_status"]
          timer_mode?: Database["public"]["Enums"]["timer_mode"]
          venue_lat?: number | null
          venue_lng?: number | null
        }
        Update: {
          ante_enabled?: boolean
          blind_structure_id?: string | null
          buy_in?: number
          cancelled_at?: string | null
          counts_for_league?: boolean
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          current_level?: number
          final_table_size?: number | null
          geofence_radius_m?: number
          id?: string
          is_paused?: boolean
          level_started_at?: string | null
          name?: string
          odds_enabled?: boolean
          paused_remaining_seconds?: number | null
          payout_distribution?: Json | null
          prize_pool_override?: number | null
          prizes?: Json | null
          rebuy_amount?: number | null
          rebuy_until_level?: number | null
          scheduled_at?: string
          season_id?: string
          starting_stack?: number | null
          status?: Database["public"]["Enums"]["tournament_status"]
          timer_mode?: Database["public"]["Enums"]["timer_mode"]
          venue_lat?: number | null
          venue_lng?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_blind_structure_id_fkey"
            columns: ["blind_structure_id"]
            isOneToOne: false
            referencedRelation: "blind_structure"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "player"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "season"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_guest_entry: {
        Args: { p_name: string; p_tournament_id: string }
        Returns: string
      }
      add_rebuy: {
        Args: { p_entry_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      admin_check_in: {
        Args: { p_entry_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      approve_request: { Args: { p_id: string }; Returns: string }
      auth_is_admin: { Args: never; Returns: boolean }
      auth_player_id: { Args: never; Returns: string }
      cancel_rsvp: {
        Args: { p_tournament_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      check_in: {
        Args: { p_lat: number; p_lng: number; p_tournament_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_player: {
        Args: never
        Returns: {
          auth_user_id: string | null
          avatar_url: string | null
          blocked: boolean
          created_at: string
          email: string
          id: string
          is_admin: boolean
          is_guest: boolean
          name: string
        }[]
        SetofOptions: {
          from: "*"
          to: "player"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      clock: {
        Args: { p_action: string; p_payload?: Json; p_tournament_id: string }
        Returns: {
          ante_enabled: boolean
          blind_structure_id: string | null
          buy_in: number
          cancelled_at: string | null
          counts_for_league: boolean
          cover_url: string | null
          created_at: string
          created_by: string | null
          current_level: number
          final_table_size: number | null
          geofence_radius_m: number
          id: string
          is_paused: boolean
          level_started_at: string | null
          name: string
          odds_enabled: boolean
          paused_remaining_seconds: number | null
          payout_distribution: Json | null
          prize_pool_override: number | null
          prizes: Json | null
          rebuy_amount: number | null
          rebuy_until_level: number | null
          scheduled_at: string
          season_id: string
          starting_stack: number | null
          status: Database["public"]["Enums"]["tournament_status"]
          timer_mode: Database["public"]["Enums"]["timer_mode"]
          venue_lat: number | null
          venue_lng: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "tournament"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      close_season: {
        Args: never
        Returns: {
          auto_approve_signups: boolean
          bonus_attendance: number
          bonus_final_table: number
          bonus_top3: number
          cancel_bands: Json
          created_at: string
          early_bird_bonus_chips: number
          final_table_size_override: number | null
          id: string
          name: string
          no_show_penalty: number
          payout_template: Json
          points_multiplier: number
          status: Database["public"]["Enums"]["season_status"]
          top_finish_bonuses: Json
          year: number
        }[]
        SetofOptions: {
          from: "*"
          to: "season"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_tournament: {
        Args: { p_chop_entry_ids?: string[]; p_tournament_id: string }
        Returns: {
          ante_enabled: boolean
          blind_structure_id: string | null
          buy_in: number
          cancelled_at: string | null
          counts_for_league: boolean
          cover_url: string | null
          created_at: string
          created_by: string | null
          current_level: number
          final_table_size: number | null
          geofence_radius_m: number
          id: string
          is_paused: boolean
          level_started_at: string | null
          name: string
          odds_enabled: boolean
          paused_remaining_seconds: number | null
          payout_distribution: Json | null
          prize_pool_override: number | null
          prizes: Json | null
          rebuy_amount: number | null
          rebuy_until_level: number | null
          scheduled_at: string
          season_id: string
          starting_stack: number | null
          status: Database["public"]["Enums"]["tournament_status"]
          timer_mode: Database["public"]["Enums"]["timer_mode"]
          venue_lat: number | null
          venue_lng: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "tournament"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      confirm_payment: {
        Args: { p_entry_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_player: {
        Args: { p_email: string; p_name: string }
        Returns: {
          auth_user_id: string | null
          avatar_url: string | null
          blocked: boolean
          created_at: string
          email: string
          id: string
          is_admin: boolean
          is_guest: boolean
          name: string
        }[]
        SetofOptions: {
          from: "*"
          to: "player"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_tournament: {
        Args: { p_payload: Json }
        Returns: {
          ante_enabled: boolean
          blind_structure_id: string | null
          buy_in: number
          cancelled_at: string | null
          counts_for_league: boolean
          cover_url: string | null
          created_at: string
          created_by: string | null
          current_level: number
          final_table_size: number | null
          geofence_radius_m: number
          id: string
          is_paused: boolean
          level_started_at: string | null
          name: string
          odds_enabled: boolean
          paused_remaining_seconds: number | null
          payout_distribution: Json | null
          prize_pool_override: number | null
          prizes: Json | null
          rebuy_amount: number | null
          rebuy_until_level: number | null
          scheduled_at: string
          season_id: string
          starting_stack: number | null
          status: Database["public"]["Enums"]["tournament_status"]
          timer_mode: Database["public"]["Enums"]["timer_mode"]
          venue_lat: number | null
          venue_lng: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "tournament"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      delete_tournament: { Args: { p_id: string }; Returns: undefined }
      eliminate: {
        Args: { p_entry_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      eliminate_multi: {
        Args: { p_entry_ids: string[]; p_tied?: boolean }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fn_eliminate_entry: { Args: { p_entry_id: string }; Returns: string }
      fn_final_table_size: {
        Args: { p_checked_in: number; p_season_id: string }
        Returns: number
      }
      fn_is_tournament_admin: {
        Args: { p_tournament_id: string }
        Returns: boolean
      }
      fn_pot: { Args: { p_tournament_id: string }; Returns: number }
      fn_tournament_points: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      leaderboard: {
        Args: { p_season_id: string }
        Returns: {
          avatar_url: string
          form: string[]
          form_positions: number[]
          games_played: number
          player_id: string
          player_name: string
          podiums: number
          total_points: number
          wins: number
        }[]
      }
      mark_no_show: {
        Args: { p_entry_id: string; p_excused: boolean }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      open_tournament: {
        Args: { p_tournament_id: string }
        Returns: {
          ante_enabled: boolean
          blind_structure_id: string | null
          buy_in: number
          cancelled_at: string | null
          counts_for_league: boolean
          cover_url: string | null
          created_at: string
          created_by: string | null
          current_level: number
          final_table_size: number | null
          geofence_radius_m: number
          id: string
          is_paused: boolean
          level_started_at: string | null
          name: string
          odds_enabled: boolean
          paused_remaining_seconds: number | null
          payout_distribution: Json | null
          prize_pool_override: number | null
          prizes: Json | null
          rebuy_amount: number | null
          rebuy_until_level: number | null
          scheduled_at: string
          season_id: string
          starting_stack: number | null
          status: Database["public"]["Enums"]["tournament_status"]
          timer_mode: Database["public"]["Enums"]["timer_mode"]
          venue_lat: number | null
          venue_lng: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "tournament"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      player_profile: {
        Args: { p_player_id: string; p_season_id?: string }
        Returns: {
          avatar_url: string
          form: string[]
          games_played: number
          player_id: string
          player_name: string
          podiums: number
          points_history: Json
          total_points: number
          wins: number
        }[]
      }
      recompute_final_table_size: {
        Args: { p_tournament_id: string }
        Returns: number
      }
      reject_request: { Args: { p_id: string }; Returns: undefined }
      request_access: { Args: { p_email: string }; Returns: string }
      rsvp: {
        Args: { p_choice: string; p_tournament_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      self_bust: {
        Args: { p_tournament_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      set_auto_approve: { Args: { p_on: boolean }; Returns: undefined }
      set_player_blocked: {
        Args: { p_blocked: boolean; p_player_id: string }
        Returns: undefined
      }
      set_prizes: { Args: { p_tournament_id: string }; Returns: Json }
      set_prizes_manual: {
        Args: { p_amounts: Json; p_tournament_id: string }
        Returns: Json
      }
      undo_last_elimination: {
        Args: { p_tournament_id: string }
        Returns: {
          cancelled_at: string | null
          check_in_geo_ok: boolean | null
          checked_in_at: string | null
          chips: number | null
          chop_group: number | null
          chopped: boolean
          created_at: string
          early_bird: boolean
          eliminated_at: string | null
          final_position: number | null
          id: string
          made_final_table: boolean
          paid: boolean
          player_id: string
          points_earned: number | null
          rebuys_count: number
          rsvp_at: string | null
          status: Database["public"]["Enums"]["entry_status"]
          tournament_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "entry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      update_own_profile: {
        Args: { p_avatar_url?: string; p_name?: string }
        Returns: {
          auth_user_id: string | null
          avatar_url: string | null
          blocked: boolean
          created_at: string
          email: string
          id: string
          is_admin: boolean
          is_guest: boolean
          name: string
        }[]
        SetofOptions: {
          from: "*"
          to: "player"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      update_season_config: {
        Args: { p_payload: Json }
        Returns: {
          auto_approve_signups: boolean
          bonus_attendance: number
          bonus_final_table: number
          bonus_top3: number
          cancel_bands: Json
          created_at: string
          early_bird_bonus_chips: number
          final_table_size_override: number | null
          id: string
          name: string
          no_show_penalty: number
          payout_template: Json
          points_multiplier: number
          status: Database["public"]["Enums"]["season_status"]
          top_finish_bonuses: Json
          year: number
        }[]
        SetofOptions: {
          from: "*"
          to: "season"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      entry_status:
        | "invited"
        | "confirmed"
        | "declined"
        | "checked_in"
        | "no_show"
        | "playing"
        | "eliminated"
        | "winner"
      season_status: "active" | "archived"
      timer_mode: "auto" | "manual"
      tournament_status: "scheduled" | "live" | "completed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      entry_status: [
        "invited",
        "confirmed",
        "declined",
        "checked_in",
        "no_show",
        "playing",
        "eliminated",
        "winner",
      ],
      season_status: ["active", "archived"],
      timer_mode: ["auto", "manual"],
      tournament_status: ["scheduled", "live", "completed"],
    },
  },
} as const

