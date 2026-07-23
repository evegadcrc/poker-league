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
      player: {
        Row: {
          auth_user_id: string | null
          avatar_url: string | null
          created_at: string
          email: string
          id: string
          is_admin: boolean
          name: string
        }
        Insert: {
          auth_user_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email: string
          id?: string
          is_admin?: boolean
          name: string
        }
        Update: {
          auth_user_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string
          id?: string
          is_admin?: boolean
          name?: string
        }
        Relationships: []
      }
      season: {
        Row: {
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
          year: number
        }
        Insert: {
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
          year: number
        }
        Update: {
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
          year?: number
        }
        Relationships: []
      }
      tournament: {
        Row: {
          ante_enabled: boolean
          blind_structure_id: string | null
          buy_in: number
          created_at: string
          created_by: string | null
          current_level: number
          final_table_size: number | null
          geofence_radius_m: number
          id: string
          is_paused: boolean
          level_started_at: string | null
          name: string
          paused_remaining_seconds: number | null
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
          created_at?: string
          created_by?: string | null
          current_level?: number
          final_table_size?: number | null
          geofence_radius_m?: number
          id?: string
          is_paused?: boolean
          level_started_at?: string | null
          name: string
          paused_remaining_seconds?: number | null
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
          created_at?: string
          created_by?: string | null
          current_level?: number
          final_table_size?: number | null
          geofence_radius_m?: number
          id?: string
          is_paused?: boolean
          level_started_at?: string | null
          name?: string
          paused_remaining_seconds?: number | null
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
      auth_is_admin: { Args: never; Returns: boolean }
      auth_player_id: { Args: never; Returns: string }
      claim_player: {
        Args: never
        Returns: {
          auth_user_id: string | null
          avatar_url: string | null
          created_at: string
          email: string
          id: string
          is_admin: boolean
          name: string
        }[]
        SetofOptions: {
          from: "*"
          to: "player"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fn_final_table_size: {
        Args: { p_checked_in: number; p_season_id: string }
        Returns: number
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
          games_played: number
          player_id: string
          player_name: string
          podiums: number
          total_points: number
          wins: number
        }[]
      }
      open_tournament: {
        Args: { p_tournament_id: string }
        Returns: {
          ante_enabled: boolean
          blind_structure_id: string | null
          buy_in: number
          created_at: string
          created_by: string | null
          current_level: number
          final_table_size: number | null
          geofence_radius_m: number
          id: string
          is_paused: boolean
          level_started_at: string | null
          name: string
          paused_remaining_seconds: number | null
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
      recompute_final_table_size: {
        Args: { p_tournament_id: string }
        Returns: number
      }
      set_prizes: { Args: { p_tournament_id: string }; Returns: Json }
      set_prizes_manual: {
        Args: { p_amounts: Json; p_tournament_id: string }
        Returns: Json
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

