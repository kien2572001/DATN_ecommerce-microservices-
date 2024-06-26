import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity()
export class InventoryEntity {
  @PrimaryGeneratedColumn()
  inventory_id: number;

  @Index()
  @Column()
  product_id: string;

  @Index()
  @Column()
  shard_index: number;

  @Column({
    nullable: true,
  })
  classification_main_id: string;

  @Column({
    nullable: true,
  })
  classification_sub_id: string;

  @Column('json', { nullable: true })
  thumbnail: Record<string, any>;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
