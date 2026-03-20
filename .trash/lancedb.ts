import { connect, Table } from '@lancedb/lancedb';

type Database = Awaited<ReturnType<typeof connect>>;

export interface VectorSearchResult {
  entryId: number;
  distance: number;
}

export interface VectorMetadata {
  entry_type?: string;
  tags?: string;
  created_at?: string;
}

export class LanceVectorStore {
  private db: Database | null = null;
  private table: Table | null = null;
  private readonly tableName = 'unified_vectors';
  
  constructor(
    private readonly dbPath: string,
    private readonly logger: any
  ) {}

  async init(): Promise<void> {
    try {
      this.logger.info('Initializing LanceDB vector store', { path: this.dbPath });
      
      // Connect to database
      this.db = await connect(this.dbPath);
      
      // Check if table exists
      const tableNames = await this.db.tableNames();
      
      if (!tableNames.includes(this.tableName)) {
        this.logger.info('Creating unified_vectors table in LanceDB');
        
        // Create table with schema
        // LanceDB requires at least one row to create the table
        const sampleData = [{
          entry_id: 0,
          text: 'sample',
          vector: new Array(4096).fill(0.0),
          entry_type: 'sample',
          tags: '',
          created_at: new Date().toISOString()
        }];
        
        this.table = await this.db.createTable(this.tableName, sampleData);
        
        // Delete the sample row
        if (this.table) await this.table.delete('entry_id = 0');
      } else {
        this.logger.info('Using existing unified_vectors table in LanceDB');
        this.table = await this.db.openTable(this.tableName);
      }
      
      this.logger.info('LanceDB vector store initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize LanceDB vector store', { error });
      throw error;
    }
  }

  async store(
    entryId: number, 
    text: string, 
    embedding: number[], 
    metadata: VectorMetadata = {}
  ): Promise<boolean> {
    if (!this.table) {
      throw new Error('LanceDB not initialized - call init() first');
    }

    try {
      // First check if entry already exists and delete it
      const existingCount = await this.table.countRows(`entry_id = ${entryId}`);
      if (existingCount > 0) {
        await this.table.delete(`entry_id = ${entryId}`);
      }

      // Prepare the data
      const data = [{
        entry_id: entryId,
        text: text.slice(0, 500), // Limit text to first 500 chars
        vector: embedding,
        entry_type: metadata.entry_type || '',
        tags: metadata.tags || '',
        created_at: metadata.created_at || new Date().toISOString()
      }];

      // Insert the new data
      await this.table.add(data);
      
      this.logger.debug('Stored vector in LanceDB', { entryId, textLength: text.length });
      return true;
    } catch (error) {
      this.logger.error('Failed to store vector in LanceDB', { entryId, error });
      return false;
    }
  }

  async search(
    queryEmbedding: number[], 
    topK: number = 10, 
    filters?: Record<string, any>
  ): Promise<VectorSearchResult[]> {
    if (!this.table) {
      throw new Error('LanceDB not initialized - call init() first');
    }

    try {
      let query = this.table.search(queryEmbedding).limit(topK);
      
      // Apply filters if provided
      if (filters) {
        const filterClauses: string[] = [];
        
        if (filters.entry_type) {
          filterClauses.push(`entry_type = '${filters.entry_type}'`);
        }
        
        if (filters.tags) {
          filterClauses.push(`tags LIKE '%${filters.tags}%'`);
        }
        
        if (filterClauses.length > 0) {
          query = query.where(filterClauses.join(' AND '));
        }
      }

      const results = await query.toArray();
      
      return results.map((row: any) => ({
        entryId: row.entry_id,
        distance: row._distance
      }));
    } catch (error) {
      this.logger.error('Failed to search vectors in LanceDB', { error });
      throw error;
    }
  }

  async delete(entryId: number): Promise<boolean> {
    if (!this.table) {
      throw new Error('LanceDB not initialized - call init() first');
    }

    try {
      await this.table.delete(`entry_id = ${entryId}`);
      this.logger.debug('Deleted vector from LanceDB', { entryId });
      return true;
    } catch (error) {
      this.logger.error('Failed to delete vector from LanceDB', { entryId, error });
      return false;
    }
  }

  async count(): Promise<number> {
    if (!this.table) {
      throw new Error('LanceDB not initialized - call init() first');
    }

    try {
      return await this.table.countRows();
    } catch (error) {
      this.logger.error('Failed to count vectors in LanceDB', { error });
      return 0;
    }
  }

  async has(entryId: number): Promise<boolean> {
    if (!this.table) {
      throw new Error('LanceDB not initialized - call init() first');
    }

    try {
      const count = await this.table.countRows(`entry_id = ${entryId}`);
      return count > 0;
    } catch (error) {
      this.logger.error('Failed to check if entry exists in LanceDB', { entryId, error });
      return false;
    }
  }
}
